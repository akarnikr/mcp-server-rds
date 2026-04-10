import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { chromium, type Browser, type Frame } from "playwright";

import { CacheService } from "../common/cache.service.js";
import { ParserService } from "./parser.service.js";
import type {
  CachedRdsData,
  ParsedComponentData,
  RdsComponentMetadata,
  RdsComponentRecord,
  RdsStoryRecord,
  ScrapeRunResult,
  ScrapedPagePayload,
} from "./types.js";

const DOCS_ROOT_URL = "https://rds-vue-ui.edpl.us/";
const INDEX_JSON_URL = new URL("index.json", DOCS_ROOT_URL).toString();
const NAV_PATH_FRAGMENT = "/components/";
const CACHE_SCHEMA_VERSION = 1;
const BATCH_SIZE = 3;
const INTER_BATCH_DELAY_MS = 1000;
const PAGE_TIMEOUT_MS = 20_000;

@Injectable()
export class ScraperService implements OnApplicationShutdown {
  private browser: Browser | null = null;
  private browserLaunchPromise: Promise<Browser> | null = null;

  constructor(
    private readonly cacheService: CacheService,
    private readonly parserService: ParserService,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.closeBrowser();
  }

  async getRdsData(options?: { forceRefresh?: boolean }): Promise<ScrapeRunResult> {
    const startedAt = Date.now();
    const forceRefresh = options?.forceRefresh ?? false;

    if (!forceRefresh) {
      const freshCache = await this.cacheService.getFreshCache();
      if (freshCache) {
        return {
          data: freshCache,
          fromCache: true,
          usedStaleCache: false,
          warnings: [],
          durationMs: Date.now() - startedAt,
        };
      }
    }

    return this.runLiveRefresh(startedAt);
  }

  async getComponentDetails(componentId: string): Promise<{
    parsed: CachedRdsData["detailsById"][string] | null;
    fromCache: boolean;
  }> {
    const inputId = this.normalizeComponentId(componentId);
    if (!inputId) {
      return { parsed: null, fromCache: false };
    }
    const normalizedId = await this.resolveCanonicalComponentId(inputId);
    if (!normalizedId) {
      return { parsed: null, fromCache: false };
    }

    const freshCache = await this.cacheService.getFreshCache();
    if (freshCache?.detailsById[normalizedId]) {
      return { parsed: freshCache.detailsById[normalizedId], fromCache: true };
    }

    const staleCache = await this.cacheService.readCache();
    const cachedComponent = staleCache?.components.find(
      (component) => component.componentId === normalizedId,
    );
    const resolvedComponent =
      cachedComponent ?? (await this.resolveComponentFromIndex(normalizedId));

    if (!resolvedComponent) {
      return { parsed: null, fromCache: false };
    }

    try {
      const browser = await this.getBrowser();
      const scrapeResult = await this.scrapeSingleComponent(browser, resolvedComponent);
      if (!scrapeResult.payload) {
        if (staleCache?.detailsById[normalizedId]) {
          return {
            parsed: staleCache.detailsById[normalizedId],
            fromCache: true,
          };
        }
        return { parsed: null, fromCache: false };
      }

      const parsed = this.parserService.toParsedData(scrapeResult.payload);
      await this.upsertSingleComponentCache(resolvedComponent, parsed);
      return { parsed, fromCache: false };
    } catch (error) {
      console.error(`Failed single component scrape for ${normalizedId}:`, error);
      if (staleCache?.detailsById[normalizedId]) {
        return { parsed: staleCache.detailsById[normalizedId], fromCache: true };
      }
      return { parsed: null, fromCache: false };
    }
  }

  async getComponentMetadata(
    componentRef: string,
  ): Promise<RdsComponentMetadata | { error: string }> {
    const normalizedInput = this.normalizeComponentRef(componentRef);
    if (!normalizedInput) {
      return { error: `Component not found: ${componentRef}` };
    }

    const detailsResult = await this.getComponentDetails(normalizedInput);
    const parsed = detailsResult.parsed;
    if (!parsed) {
      return { error: `Component not found: ${componentRef}` };
    }
    const componentId = parsed.componentId;

    const stories = await this.findStoriesForComponent(componentId);
    const packageInfo = await this.resolvePackageInfo(componentId);
    const category = this.extractCategoryFromStories(stories);

    const warnings = [...(parsed.warnings ?? [])];
    if (stories.length === 0) {
      warnings.push("No matching stories were found in Storybook index.");
    }
    if (!packageInfo.packageName) {
      warnings.push("Unable to resolve npm package metadata for component.");
    }

    if (parsed.propsRows.length === 0) {
      warnings.push("No props rows parsed for this component.");
    }
    warnings.push(
      "Events and slots are not explicitly documented in source tables; returned as empty arrays.",
    );

    const description =
      packageInfo.description ??
      this.firstNonEmptyPropField(parsed, ["Description", "description"]) ??
      null;

    const metadata = {
      name: this.toPascalCase(componentId),
      package: packageInfo.packageName,
      version: packageInfo.version,
      description,
      category,
      props: parsed.propsRows,
      events: [],
      slots: [],
      stories,
      peerDependencies: packageInfo.peerDependencies,
      lastPublished: packageInfo.lastPublished,
      importStatement: packageInfo.packageName
        ? `import { ${this.toPascalCase(componentId)} } from "${packageInfo.packageName}";`
        : null,
      installCommand: packageInfo.packageName
        ? `yarn add ${packageInfo.packageName}`
        : null,
      sourceMeta: {
        docsUrl: parsed.url,
        indexJsonUrl: INDEX_JSON_URL,
        npmRegistryUrl: packageInfo.registryUrl,
        fetchedAt: new Date().toISOString(),
        fromCache: detailsResult.fromCache,
      },
      metadataCompleteness: this.computeCompleteness({
        props: parsed.propsRows,
        stories,
        packageName: packageInfo.packageName,
        version: packageInfo.version,
        description,
        lastPublished: packageInfo.lastPublished,
      }),
      warnings,
    } satisfies RdsComponentMetadata;

    return metadata;
  }

  private async runLiveRefresh(startedAt: number): Promise<ScrapeRunResult> {
    const staleCache = await this.cacheService.readCache();

    try {
      const browser = await this.getBrowser();
      const components = await this.discoverComponents(browser);
      if (components.length === 0) {
        throw new Error("Component discovery returned no results.");
      }
      const { payloads: pagePayloads, warnings } =
        await this.scrapeComponentPages(browser, components);

      const detailsById: CachedRdsData["detailsById"] = {};
      for (const payload of pagePayloads) {
        detailsById[payload.componentId] = this.parserService.toParsedData(payload);
      }

      const data: CachedRdsData = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        sourceSite: DOCS_ROOT_URL,
        components,
        detailsById,
      };

      await this.cacheService.writeCache(data);

      return {
        data,
        fromCache: false,
        usedStaleCache: false,
        warnings,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      console.error("Live scrape failed:", error);
      if (staleCache) {
        return {
          data: staleCache,
          fromCache: true,
          usedStaleCache: true,
          warnings: [
            "Live scrape failed; stale cache served as fallback.",
          ],
          durationMs: Date.now() - startedAt,
        };
      }
      throw error;
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    if (this.browserLaunchPromise) {
      return this.browserLaunchPromise;
    }

    this.browserLaunchPromise = chromium
      .launch({ headless: true })
      .then((browser) => {
        this.browser = browser;
        return browser;
      })
      .finally(() => {
        this.browserLaunchPromise = null;
      });

    return this.browserLaunchPromise;
  }

  private async closeBrowser(): Promise<void> {
    if (!this.browser) {
      return;
    }
    const browser = this.browser;
    this.browser = null;
    try {
      await browser.close();
    } catch (error) {
      console.error("Failed to close Playwright browser during shutdown:", error);
    }
  }

  private async discoverComponents(
    browser: Awaited<ReturnType<typeof chromium.launch>>,
  ): Promise<RdsComponentRecord[]> {
    const [anchorDiscovered, indexDiscovered] = await Promise.all([
      this.discoverFromAnchors(browser),
      this.discoverFromIndexJson(browser),
    ]);

    const uniqueById = new Map<string, RdsComponentRecord>();
    for (const component of [...anchorDiscovered, ...indexDiscovered]) {
      if (!uniqueById.has(component.componentId)) {
        uniqueById.set(component.componentId, component);
      }
    }

    return Array.from(uniqueById.values()).sort((a, b) =>
      a.componentId.localeCompare(b.componentId),
    );
  }

  private async discoverFromAnchors(
    browser: Awaited<ReturnType<typeof chromium.launch>>,
  ): Promise<RdsComponentRecord[]> {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(DOCS_ROOT_URL, {
        waitUntil: "networkidle",
        timeout: PAGE_TIMEOUT_MS,
      });

      const hrefs = await page.$$eval("a[href]", (anchors) =>
        anchors
          .map((anchor) => anchor.getAttribute("href"))
          .filter((href): href is string => Boolean(href)),
      );

      const records: RdsComponentRecord[] = [];
      for (const href of hrefs) {
        const absoluteUrl = this.toAbsoluteUrl(href);
        if (!absoluteUrl || !absoluteUrl.pathname.includes(NAV_PATH_FRAGMENT)) {
          continue;
        }

        const componentId = this.normalizeSlugFromPath(absoluteUrl.pathname);
        if (!componentId) {
          continue;
        }

        records.push({
          componentId,
          title: this.titleFromSlug(componentId),
          url: absoluteUrl.toString(),
        });
      }

      return records;
    } catch (error) {
      console.error("Anchor discovery failed:", error);
      return [];
    } finally {
      await page.close();
      await context.close();
    }
  }

  private async discoverFromIndexJson(
    browser: Awaited<ReturnType<typeof chromium.launch>>,
  ): Promise<RdsComponentRecord[]> {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(INDEX_JSON_URL, {
        waitUntil: "networkidle",
        timeout: PAGE_TIMEOUT_MS,
      });

      const raw = await page.textContent("body");
      if (!raw) {
        return [];
      }

      const parsed = JSON.parse(raw) as {
        entries?: Record<string, { id?: string; title?: string }>;
      };

      const entries = Object.values(parsed.entries ?? {});
      const records: RdsComponentRecord[] = [];

      for (const entry of entries) {
        const storyId = entry.id?.trim() ?? "";
        const storyTitle = entry.title?.trim() ?? "";
        if (!storyId.startsWith("components-") || !storyId.endsWith("--docs")) {
          continue;
        }
        if (!storyTitle.toLowerCase().startsWith("components/")) {
          continue;
        }

        const titleLeaf = storyTitle.split("/").at(-1) ?? storyId;
        const componentId = this.slugifyValue(titleLeaf);
        if (!componentId) {
          continue;
        }

        records.push({
          componentId,
          title: titleLeaf,
          url: `${DOCS_ROOT_URL}?path=/docs/${storyId}`,
        });
      }

      return records;
    } catch (error) {
      console.error("Index.json discovery failed:", error);
      return [];
    } finally {
      await page.close();
      await context.close();
    }
  }

  private async resolveComponentFromIndex(
    componentId: string,
  ): Promise<RdsComponentRecord | null> {
    try {
      const response = await fetch(INDEX_JSON_URL);
      if (!response.ok) {
        return null;
      }

      const parsed = (await response.json()) as {
        entries?: Record<string, { id?: string; title?: string }>;
      };
      const entries = Object.values(parsed.entries ?? {});

      for (const entry of entries) {
        const storyId = entry.id?.trim() ?? "";
        const storyTitle = entry.title?.trim() ?? "";
        if (!storyId.startsWith("components-") || !storyId.endsWith("--docs")) {
          continue;
        }
        if (!storyTitle.toLowerCase().startsWith("components/")) {
          continue;
        }

        const titleLeaf = storyTitle.split("/").at(-1) ?? storyId;
        const slug = this.slugifyValue(titleLeaf);
        if (slug !== componentId) {
          continue;
        }

        return {
          componentId: slug,
          title: titleLeaf,
          url: `${DOCS_ROOT_URL}?path=/docs/${storyId}`,
        };
      }
    } catch (error) {
      console.error("Failed to resolve component from index.json:", error);
    }

    return null;
  }

  private async findStoriesForComponent(
    componentId: string,
  ): Promise<RdsStoryRecord[]> {
    try {
      const response = await fetch(INDEX_JSON_URL);
      if (!response.ok) {
        return [];
      }

      const parsed = (await response.json()) as {
        entries?: Record<string, { id?: string; title?: string; type?: string }>;
      };
      const entries = Object.values(parsed.entries ?? {});

      const stories: RdsStoryRecord[] = [];
      for (const entry of entries) {
        const storyId = entry.id?.trim() ?? "";
        const storyTitle = entry.title?.trim() ?? "";
        const storyType = entry.type?.trim() ?? "unknown";
        if (!storyId.startsWith("components-") || !storyTitle) {
          continue;
        }

        const leaf = storyTitle.split("/").at(-1) ?? "";
        if (this.slugifyValue(leaf) !== componentId) {
          continue;
        }

        const isDocs = storyId.endsWith("--docs");
        stories.push({
          id: storyId,
          title: storyTitle,
          type: storyType,
          url: isDocs
            ? `${DOCS_ROOT_URL}?path=/docs/${storyId}`
            : `${DOCS_ROOT_URL}?path=/story/${storyId}`,
        });
      }

      return stories;
    } catch (error) {
      console.error("Failed to fetch stories for component:", error);
      return [];
    }
  }

  private async scrapeComponentPages(
    browser: Awaited<ReturnType<typeof chromium.launch>>,
    components: RdsComponentRecord[],
  ): Promise<{ payloads: ScrapedPagePayload[]; warnings: string[] }> {
    const payloads: ScrapedPagePayload[] = [];
    const warnings: string[] = [];

    for (let index = 0; index < components.length; index += BATCH_SIZE) {
      const batch = components.slice(index, index + BATCH_SIZE);
      const batchPayloads = await Promise.all(
        batch.map((component) => this.scrapeSingleComponent(browser, component)),
      );

      for (const result of batchPayloads) {
        if (result.payload) {
          payloads.push(result.payload);
        }
        if (result.warning) {
          warnings.push(result.warning);
        }
      }

      const hasMoreBatches = index + BATCH_SIZE < components.length;
      if (hasMoreBatches) {
        await this.sleep(INTER_BATCH_DELAY_MS);
      }
    }

    return { payloads, warnings };
  }

  private async scrapeSingleComponent(
    browser: Awaited<ReturnType<typeof chromium.launch>>,
    component: RdsComponentRecord,
  ): Promise<{ payload: ScrapedPagePayload | null; warning?: string }> {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(component.url, {
        waitUntil: "networkidle",
        timeout: PAGE_TIMEOUT_MS,
      });
      const docsFrame = page
        .frames()
        .find(
          (frame) =>
            frame.url().includes("/iframe.html") &&
            frame.url().includes("viewMode=docs"),
        );
      if (docsFrame) {
        await this.expandStorybookCodeSections(docsFrame);
      }
      const html = docsFrame ? await docsFrame.content() : await page.content();

      return {
        payload: {
          componentId: component.componentId,
          url: component.url,
          html,
        },
      };
    } catch (error) {
      console.error(`Failed to scrape component page ${component.url}:`, error);
      return {
        payload: null,
        warning: `Failed to scrape ${component.componentId} (${component.url}).`,
      };
    } finally {
      await page.close();
      await context.close();
    }
  }

  private toAbsoluteUrl(href: string): URL | null {
    try {
      return new URL(href, DOCS_ROOT_URL);
    } catch {
      return null;
    }
  }

  private normalizeSlugFromPath(pathname: string): string {
    const clean = pathname.replace(/\/+$/, "");
    const lastSegment = clean.split("/").at(-1)?.trim().toLowerCase() ?? "";
    return lastSegment.replace(/[^a-z0-9-]/g, "");
  }

  private normalizeComponentId(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  }

  private normalizeComponentRef(value: string): string {
    const raw = value.trim();
    if (!raw) {
      return "";
    }

    if (raw.startsWith("@rds-vue-ui/")) {
      return this.normalizeComponentId(raw.replace("@rds-vue-ui/", ""));
    }

    if (/^Rds[A-Z]/.test(raw)) {
      return this.slugifyValue(raw.replace(/^Rds/, ""));
    }

    return this.normalizeComponentId(raw);
  }

  private async resolveCanonicalComponentId(
    requestedId: string,
  ): Promise<string | null> {
    const staleCache = await this.cacheService.readCache();
    const fromCache = (staleCache?.components ?? []).map((item) => item.componentId);
    const fromIndex = await this.getComponentIdsFromIndex();
    const candidateIds = Array.from(new Set([...fromCache, ...fromIndex]));

    if (candidateIds.length === 0) {
      return requestedId;
    }

    if (candidateIds.includes(requestedId)) {
      return requestedId;
    }

    const ranked = candidateIds
      .map((id) => ({ id, score: this.matchScore(requestedId, id) }))
      .filter((entry) => entry.score < Number.POSITIVE_INFINITY)
      .sort((a, b) => a.score - b.score || a.id.length - b.id.length || a.id.localeCompare(b.id));

    return ranked[0]?.id ?? null;
  }

  private titleFromSlug(slug: string): string {
    return slug
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  private slugifyValue(value: string): string {
    return value
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private async upsertSingleComponentCache(
    component: RdsComponentRecord,
    parsed: CachedRdsData["detailsById"][string],
  ): Promise<void> {
    const existing = await this.cacheService.readCache();
    const data: CachedRdsData = existing ?? {
      schemaVersion: CACHE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      sourceSite: DOCS_ROOT_URL,
      components: [],
      detailsById: {},
    };

    data.schemaVersion = CACHE_SCHEMA_VERSION;
    data.updatedAt = new Date().toISOString();
    data.sourceSite = DOCS_ROOT_URL;

    const existingIndex = data.components.findIndex(
      (item) => item.componentId === component.componentId,
    );
    if (existingIndex >= 0) {
      data.components[existingIndex] = component;
    } else {
      data.components.push(component);
      data.components.sort((a, b) => a.componentId.localeCompare(b.componentId));
    }

    data.detailsById[component.componentId] = parsed;
    await this.cacheService.writeCache(data);
  }

  private async expandStorybookCodeSections(frame: Frame): Promise<void> {
    try {
      const showCodeButtons = frame.getByRole("button", { name: /show code/i });
      const count = await showCodeButtons.count();
      for (let index = 0; index < count; index += 1) {
        await showCodeButtons.nth(index).click().catch(() => undefined);
      }
      if (count > 0) {
        await frame.waitForTimeout(300);
      }
    } catch (error) {
      console.error("Failed to expand Storybook code sections:", error);
    }
  }

  private async resolvePackageInfo(componentId: string): Promise<{
    packageName: string | null;
    version: string | null;
    description: string | null;
    peerDependencies: Record<string, string>;
    lastPublished: string | null;
    registryUrl: string | null;
  }> {
    const candidateSuffixes = Array.from(
      new Set([componentId, componentId.split("-")[0]]),
    ).filter(Boolean);

    for (const suffix of candidateSuffixes) {
      const packageName = `@rds-vue-ui/${suffix}`;
      const encoded = packageName.replace("/", "%2F");
      const registryUrl = `https://registry.npmjs.org/${encoded}`;
      try {
        const response = await fetch(registryUrl);
        if (!response.ok) {
          continue;
        }

        const body = (await response.json()) as {
          description?: string;
          time?: Record<string, string>;
          "dist-tags"?: Record<string, string>;
          versions?: Record<string, { peerDependencies?: Record<string, string> }>;
        };

        const version = body["dist-tags"]?.latest ?? null;
        const peerDependencies = version
          ? (body.versions?.[version]?.peerDependencies ?? {})
          : {};
        const lastPublished =
          (version ? body.time?.[version] : null) ?? body.time?.latest ?? null;

        return {
          packageName,
          version,
          description: body.description ?? null,
          peerDependencies,
          lastPublished,
          registryUrl,
        };
      } catch (error) {
        console.error(`Failed npm metadata fetch for ${packageName}:`, error);
      }
    }

    return {
      packageName: null,
      version: null,
      description: null,
      peerDependencies: {},
      lastPublished: null,
      registryUrl: null,
    };
  }

  private firstNonEmptyPropField(
    parsed: ParsedComponentData,
    keys: string[],
  ): string | null {
    for (const row of parsed.propsRows) {
      for (const key of keys) {
        const value = row[key];
        if (value && value.trim()) {
          return value.trim();
        }
      }
    }
    return null;
  }

  private extractCategoryFromStories(stories: RdsStoryRecord[]): string | null {
    const first = stories[0]?.title;
    if (!first) {
      return null;
    }
    const parts = first.split("/").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    return parts.slice(0, parts.length - 1).join("/");
  }

  private toPascalCase(slug: string): string {
    return slug
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
  }

  private computeCompleteness(input: {
    props: Array<Record<string, string>>;
    stories: RdsStoryRecord[];
    packageName: string | null;
    version: string | null;
    description: string | null;
    lastPublished: string | null;
  }): { score: number; missing: string[] } {
    const required = [
      { key: "props", ok: input.props.length > 0 },
      { key: "stories", ok: input.stories.length > 0 },
      { key: "package", ok: Boolean(input.packageName) },
      { key: "version", ok: Boolean(input.version) },
      { key: "description", ok: Boolean(input.description) },
      { key: "lastPublished", ok: Boolean(input.lastPublished) },
    ];

    const present = required.filter((item) => item.ok).length;
    const score = Number((present / required.length).toFixed(2));
    const missing = required.filter((item) => !item.ok).map((item) => item.key);
    return { score, missing };
  }

  private async getComponentIdsFromIndex(): Promise<string[]> {
    try {
      const response = await fetch(INDEX_JSON_URL);
      if (!response.ok) {
        return [];
      }
      const parsed = (await response.json()) as {
        entries?: Record<string, { id?: string; title?: string }>;
      };
      const entries = Object.values(parsed.entries ?? {});
      const ids = entries
        .map((entry) => entry.title?.trim() ?? "")
        .filter((title) => title.toLowerCase().startsWith("components/"))
        .map((title) => this.slugifyValue(title.split("/").at(-1) ?? ""))
        .filter(Boolean);
      return Array.from(new Set(ids));
    } catch (error) {
      console.error("Failed to fetch component IDs from index.json:", error);
      return [];
    }
  }

  private matchScore(requestedId: string, candidateId: string): number {
    if (candidateId === requestedId) {
      return 0;
    }
    if (candidateId.startsWith(`${requestedId}-`) || candidateId.startsWith(requestedId)) {
      return 1 + Math.abs(candidateId.length - requestedId.length) * 0.01;
    }
    if (candidateId.includes(requestedId)) {
      return 2 + Math.abs(candidateId.length - requestedId.length) * 0.01;
    }
    if (
      requestedId.endsWith("s") &&
      candidateId.startsWith(requestedId.slice(0, -1))
    ) {
      return 3;
    }
    if (
      candidateId.endsWith("s") &&
      candidateId.slice(0, -1) === requestedId
    ) {
      return 3;
    }
    return Number.POSITIVE_INFINITY;
  }
}
