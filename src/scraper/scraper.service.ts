import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { chromium, type Browser, type Frame } from "playwright";

import { CacheService } from "../common/cache.service.js";
import { ParserService } from "./parser.service.js";
import type {
  CachedRdsData,
  BaseThemeGuidelines,
  BaseThemeRunResult,
  ParsedComponentData,
  RdsComponentMetadata,
  RdsComponentRecord,
  RdsStoryRecord,
  ScrapeRunResult,
  ScrapedPagePayload,
  ThemeComplianceReport,
  ThemeComplianceViolation,
} from "./types.js";

const DOCS_ROOT_URL = "https://rds-vue-ui.edpl.us/";
const INDEX_JSON_URL = new URL("index.json", DOCS_ROOT_URL).toString();
const NAV_PATH_FRAGMENT = "/components/";
const BASE_THEME_TITLE = "Foundations/Base Theme";
const BASE_THEME_STORY_PREFIX = "foundations-base-theme--";
const CACHE_SCHEMA_VERSION = 3;
const GENERIC_INSTALL_FALLBACK =
  "yarn add --registry=https://npm.edpl.us @rds-vue-ui/<component-package>";
const BATCH_SIZE = 3;
const INTER_BATCH_DELAY_MS = 1000;
const PAGE_TIMEOUT_MS = 20_000;
const MAX_VALIDATION_ELEMENTS = 1500;

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
    const freshParsed = freshCache?.detailsById[normalizedId];
    if (freshParsed && freshParsed.installCommand) {
      return { parsed: freshParsed, fromCache: true };
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
      installCommand:
        parsed.installCommand ??
        (packageInfo.packageName
          ? `yarn add --registry=https://npm.edpl.us ${packageInfo.packageName}`
          : GENERIC_INSTALL_FALLBACK),
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

  async getBaseThemeGuidelines(
    options?: { forceRefresh?: boolean },
  ): Promise<BaseThemeRunResult> {
    const startedAt = Date.now();
    const forceRefresh = options?.forceRefresh ?? false;

    if (!forceRefresh) {
      const freshCache = await this.cacheService.getFreshCache();
      const cachedTheme = freshCache?.themes?.baseTheme;
      if (cachedTheme) {
        return {
          data: cachedTheme,
          fromCache: true,
          usedStaleCache: false,
          warnings: [],
          durationMs: Date.now() - startedAt,
        };
      }
    }

    const staleCache = await this.cacheService.readCache();
    const staleTheme = staleCache?.themes?.baseTheme ?? null;

    try {
      const browser = await this.getBrowser();
      const extracted = await this.scrapeBaseThemeGuidelines(browser);
      await this.upsertBaseThemeCache(extracted.guidelines);

      return {
        data: extracted.guidelines,
        fromCache: false,
        usedStaleCache: false,
        warnings: extracted.warnings,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      console.error("Failed to scrape base theme guidelines:", error);
      if (staleTheme) {
        return {
          data: staleTheme,
          fromCache: true,
          usedStaleCache: true,
          warnings: [
            "Live base theme scrape failed; stale cached base theme served.",
          ],
          durationMs: Date.now() - startedAt,
        };
      }
      throw error;
    }
  }

  async validateThemeCompliance(
    pageUrl: string,
  ): Promise<ThemeComplianceReport | { error: string }> {
    const normalizedUrl = this.normalizeExternalUrl(pageUrl);
    if (!normalizedUrl) {
      return { error: `Invalid url: ${pageUrl}` };
    }

    const themeRun = await this.getBaseThemeGuidelines();
    const baseTheme = themeRun.data;
    const warnings = [...themeRun.warnings];

    const allowedColorValues = new Set(
      baseTheme.colorValues
        .map((value) => this.normalizeColor(value))
        .filter((value): value is string => Boolean(value)),
    );
    const allowedFontFamilies = new Set(
      baseTheme.typographyFamilies.map((family) => family.toLowerCase()),
    );

    const browser = await this.getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(normalizedUrl, {
        waitUntil: "networkidle",
        timeout: PAGE_TIMEOUT_MS,
      });

      const styleSnapshot = await page.evaluate((limit) => {
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        const elements = (Array.from(doc.querySelectorAll("*")) as any[]).slice(0, limit);
        return elements.map((element) => {
          const computed = win.getComputedStyle(element);
          const descriptor = {
            tag: element.tagName.toLowerCase(),
            id: element.id || "",
            className: element.className || "",
          };
          return {
            element: `${descriptor.tag}${descriptor.id ? `#${descriptor.id}` : ""}${descriptor.className ? `.${String(descriptor.className).trim().replace(/\s+/g, ".")}` : ""}`,
            color: computed.color,
            backgroundColor: computed.backgroundColor,
            borderTopColor: computed.borderTopColor,
            borderRightColor: computed.borderRightColor,
            borderBottomColor: computed.borderBottomColor,
            borderLeftColor: computed.borderLeftColor,
            fontFamily: computed.fontFamily,
            fontSize: computed.fontSize,
          };
        });
      }, MAX_VALIDATION_ELEMENTS);

      const violations: ThemeComplianceViolation[] = [];
      const colorsToCheck = [
        "color",
        "backgroundColor",
        "borderTopColor",
        "borderRightColor",
        "borderBottomColor",
        "borderLeftColor",
      ] as const;

      for (const item of styleSnapshot) {
        for (const property of colorsToCheck) {
          const normalized = this.normalizeColor(item[property]);
          if (!normalized || this.isIgnorableColor(normalized)) {
            continue;
          }
          if (!allowedColorValues.has(normalized)) {
            violations.push({
              type: "color",
              property,
              value: item[property],
              element: item.element,
              message: `${property} uses a color not found in base theme palette tokens.`,
            });
          }
        }

        const normalizedFamily = this.normalizeFontFamily(item.fontFamily);
        if (normalizedFamily && !allowedFontFamilies.has(normalizedFamily)) {
          violations.push({
            type: "typography",
            property: "fontFamily",
            value: item.fontFamily,
            element: item.element,
            message: "fontFamily is not present in base theme typography guidelines.",
          });
        }
      }

      const cappedViolations = violations.slice(0, 200);
      if (violations.length > cappedViolations.length) {
        warnings.push(
          `Violation output capped at ${cappedViolations.length} records (found ${violations.length}).`,
        );
      }

      const checks = [
        {
          id: "base-theme-colors",
          status:
            cappedViolations.some((item) => item.type === "color") ? "fail" : "pass",
          message:
            cappedViolations.some((item) => item.type === "color")
              ? "Found colors outside base theme palette tokens."
              : "All scanned colors matched base theme palette tokens.",
        },
        {
          id: "base-theme-typography",
          status:
            cappedViolations.some((item) => item.type === "typography")
              ? "fail"
              : "pass",
          message:
            cappedViolations.some((item) => item.type === "typography")
              ? "Found font families outside base theme typography guidance."
              : "All scanned font families matched base theme typography guidance.",
        },
      ] as const;

      const totalElementsScanned = styleSnapshot.length;
      const totalViolations = violations.length;
      const scoreRaw =
        totalElementsScanned === 0
          ? 1
          : 1 - totalViolations / Math.max(totalElementsScanned * 2, 1);
      const score = Number(Math.max(0, Math.min(1, scoreRaw)).toFixed(2));

      return {
        url: normalizedUrl,
        checkedAt: new Date().toISOString(),
        fromThemeCache: themeRun.fromCache,
        summary: {
          totalElementsScanned,
          totalViolations,
          score,
          compliant: totalViolations === 0,
        },
        checks: checks.map((check) => ({
          ...check,
          status: check.status as "pass" | "fail",
        })),
        violations: cappedViolations,
        warnings,
        themeReference: {
          storyCount: baseTheme.storyCount,
          storyIds: baseTheme.storyIds,
          updatedAt: baseTheme.updatedAt,
        },
      };
    } catch (error) {
      console.error(`Failed to validate theme compliance for ${normalizedUrl}:`, error);
      return { error: `Unable to validate url: ${normalizedUrl}` };
    } finally {
      await page.close();
      await context.close();
    }
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
      const themeResult = await this.scrapeBaseThemeGuidelines(browser);

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
        themes: {
          baseTheme: themeResult.guidelines,
        },
      };

      await this.cacheService.writeCache(data);

      return {
        data,
        fromCache: false,
        usedStaleCache: false,
        warnings: [...warnings, ...themeResult.warnings],
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

  private async upsertBaseThemeCache(theme: BaseThemeGuidelines): Promise<void> {
    const existing = await this.cacheService.readCache();
    const data: CachedRdsData = existing ?? {
      schemaVersion: CACHE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      sourceSite: DOCS_ROOT_URL,
      components: [],
      detailsById: {},
      themes: {
        baseTheme: theme,
      },
    };

    data.schemaVersion = CACHE_SCHEMA_VERSION;
    data.updatedAt = new Date().toISOString();
    data.sourceSite = DOCS_ROOT_URL;
    data.themes = {
      baseTheme: theme,
    };

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

  private async scrapeBaseThemeGuidelines(
    browser: Awaited<ReturnType<typeof chromium.launch>>,
  ): Promise<{ guidelines: BaseThemeGuidelines; warnings: string[] }> {
    const warnings: string[] = [];
    const stories = await this.getBaseThemeStoriesFromIndex();
    if (stories.length === 0) {
      throw new Error("No base theme stories found in Storybook index.");
    }

    const extractedStories: BaseThemeGuidelines["stories"] = [];
    for (const story of stories) {
      const extracted = await this.scrapeBaseThemeStory(browser, story);
      extractedStories.push(extracted.story);
      if (extracted.warning) {
        warnings.push(extracted.warning);
      }
    }

    const mergedCssVars = this.mergeCssVariables(extractedStories);
    const colorTokens = this.filterTokenGroup(
      mergedCssVars,
      ["color", "palette", "primary", "secondary", "accent", "neutral", "bg", "background"],
      (value) => Boolean(this.normalizeColor(value)),
    );
    const typographyTokens = this.filterTokenGroup(
      mergedCssVars,
      ["font", "typography", "heading", "body", "line-height", "weight", "letter"],
    );
    const spacingTokens = this.filterTokenGroup(
      mergedCssVars,
      ["space", "spacing", "gap", "margin", "padding"],
    );
    const breakpoints = this.filterTokenGroup(
      mergedCssVars,
      ["breakpoint", "container", "screen", "viewport"],
    );
    const utilityClasses = this.extractUtilityClasses(extractedStories);
    const backgroundPatterns = this.extractBackgroundPatterns(extractedStories);
    const colorValues = Array.from(
      new Set(
        [
          ...Object.values(colorTokens),
          ...extractedStories.flatMap((story) => story.colors),
        ]
          .map((value) => this.normalizeColor(value))
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort();
    const typographyFamilies = Array.from(
      new Set(
        [
          ...Object.values(typographyTokens),
          ...extractedStories.flatMap((story) => story.typographyFamilies),
        ]
          .map((value) => this.normalizeFontFamily(value))
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort();

    const guidelines: BaseThemeGuidelines = {
      updatedAt: new Date().toISOString(),
      sourceSite: DOCS_ROOT_URL,
      sourceIndexUrl: INDEX_JSON_URL,
      storyCount: extractedStories.length,
      storyIds: extractedStories.map((story) => story.storyId),
      stories: extractedStories,
      colorTokens,
      typographyTokens,
      spacingTokens,
      breakpoints,
      utilityClasses,
      backgroundPatterns,
      colorValues,
      typographyFamilies,
      notes: [
        "Guidelines are scraped from Storybook Foundations/Base Theme stories.",
        "Validation currently enforces palette and typography families from base theme tokens.",
      ],
    };

    return { guidelines, warnings };
  }

  private async getBaseThemeStoriesFromIndex(): Promise<
    Array<{ id: string; title: string; name: string; storyUrl: string; iframeUrl: string }>
  > {
    const response = await fetch(INDEX_JSON_URL);
    if (!response.ok) {
      throw new Error(`Failed to load Storybook index.json: ${response.status}`);
    }

    const parsed = (await response.json()) as {
      entries?: Record<
        string,
        {
          id?: string;
          title?: string;
          name?: string;
          type?: string;
        }
      >;
    };

    const entries = Object.values(parsed.entries ?? {});
    return entries
      .filter((entry) => {
        const id = entry.id?.trim() ?? "";
        const title = entry.title?.trim() ?? "";
        return (
          entry.type === "story" &&
          title === BASE_THEME_TITLE &&
          id.startsWith(BASE_THEME_STORY_PREFIX)
        );
      })
      .map((entry) => {
        const id = entry.id?.trim() ?? "";
        const title = entry.title?.trim() ?? BASE_THEME_TITLE;
        const name = entry.name?.trim() ?? id;
        return {
          id,
          title,
          name,
          storyUrl: `${DOCS_ROOT_URL}?path=/story/${id}`,
          iframeUrl: `${DOCS_ROOT_URL}iframe.html?id=${id}&viewMode=story`,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async scrapeBaseThemeStory(
    browser: Awaited<ReturnType<typeof chromium.launch>>,
    story: { id: string; title: string; name: string; storyUrl: string; iframeUrl: string },
  ): Promise<{ story: BaseThemeGuidelines["stories"][number]; warning?: string }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(story.iframeUrl, {
        waitUntil: "networkidle",
        timeout: PAGE_TIMEOUT_MS,
      });

      const extracted = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        const root = doc.documentElement;
        const computed = win.getComputedStyle(root);
        const cssVariables: Record<string, string> = {};
        for (const propertyName of computed) {
          if (!propertyName.startsWith("--")) {
            continue;
          }
          const value = computed.getPropertyValue(propertyName).trim();
          if (!value) {
            continue;
          }
          cssVariables[propertyName] = value;
        }

        const text = (doc.body?.innerText ?? "")
          .split("\n")
          .map((line: string) => line.trim())
          .filter(Boolean);

        const html = doc.body?.innerHTML ?? "";
        const colors = Array.from(
          new Set([
            ...(Array.from(
              html.matchAll(
                /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g,
              ),
            ) as RegExpMatchArray[]).map((match) => match[0].trim()),
          ]),
        );

        const typographyFamilies = Array.from(
          new Set(
            Object.values(cssVariables)
              .filter((value) => value.includes(",") || /[A-Za-z]/.test(value))
              .filter((value) => value.toLowerCase().includes("serif") || value.includes("'") || value.includes('"')),
          ),
        );

        return {
          cssVariables,
          extractedText: text.slice(0, 800),
          colors,
          typographyFamilies,
        };
      });

      return {
        story: {
          storyId: story.id,
          title: story.title,
          name: story.name,
          url: story.storyUrl,
          iframeUrl: story.iframeUrl,
          extractedText: extracted.extractedText,
          cssVariables: extracted.cssVariables,
          colors: extracted.colors,
          typographyFamilies: extracted.typographyFamilies,
        },
      };
    } catch (error) {
      console.error(`Failed to scrape base theme story ${story.id}:`, error);
      return {
        story: {
          storyId: story.id,
          title: story.title,
          name: story.name,
          url: story.storyUrl,
          iframeUrl: story.iframeUrl,
          extractedText: [],
          cssVariables: {},
          colors: [],
          typographyFamilies: [],
          warnings: ["Unable to load story content."],
        },
        warning: `Failed to scrape base theme story ${story.id}.`,
      };
    } finally {
      await page.close();
      await context.close();
    }
  }

  private mergeCssVariables(
    stories: BaseThemeGuidelines["stories"],
  ): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const story of stories) {
      for (const [key, value] of Object.entries(story.cssVariables)) {
        if (!merged[key]) {
          merged[key] = value;
        }
      }
    }
    return merged;
  }

  private filterTokenGroup(
    tokens: Record<string, string>,
    keywords: string[],
    extraPredicate?: (value: string, key: string) => boolean,
  ): Record<string, string> {
    const selected: Record<string, string> = {};
    for (const [key, value] of Object.entries(tokens)) {
      const lowerKey = key.toLowerCase();
      if (!keywords.some((word) => lowerKey.includes(word))) {
        continue;
      }
      if (extraPredicate && !extraPredicate(value, key)) {
        continue;
      }
      selected[key] = value;
    }
    return selected;
  }

  private extractUtilityClasses(stories: BaseThemeGuidelines["stories"]): string[] {
    const classes = new Set<string>();
    for (const story of stories) {
      if (!story.storyId.endsWith("--utility-classes")) {
        continue;
      }
      for (const line of story.extractedText) {
        const matches = line.match(/\.[A-Za-z0-9_-]+/g) ?? [];
        for (const match of matches) {
          classes.add(match);
        }
      }
    }
    return Array.from(classes).sort();
  }

  private extractBackgroundPatterns(
    stories: BaseThemeGuidelines["stories"],
  ): string[] {
    const patterns = new Set<string>();
    for (const story of stories) {
      if (!story.storyId.endsWith("--background-patterns")) {
        continue;
      }
      for (const line of story.extractedText) {
        if (line.length < 3) {
          continue;
        }
        patterns.add(line);
      }
    }
    return Array.from(patterns).slice(0, 200);
  }

  private normalizeColor(value: string): string | null {
    const raw = value.trim().toLowerCase();
    if (!raw) {
      return null;
    }

    if (/^#[0-9a-f]{3,8}$/.test(raw)) {
      return this.hexToRgbString(raw);
    }

    const rgbMatch = raw.match(
      /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/,
    );
    if (rgbMatch) {
      const r = Number(rgbMatch[1]);
      const g = Number(rgbMatch[2]);
      const b = Number(rgbMatch[3]);
      const a = rgbMatch[4] !== undefined ? Number(rgbMatch[4]) : undefined;
      if ([r, g, b].some((n) => Number.isNaN(n))) {
        return null;
      }
      if (a === undefined || Number.isNaN(a) || a >= 1) {
        return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
      }
      return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(a.toFixed(3))})`;
    }

    return null;
  }

  private hexToRgbString(hex: string): string | null {
    const value = hex.replace("#", "").trim();
    if (![3, 4, 6, 8].includes(value.length)) {
      return null;
    }

    let r = 0;
    let g = 0;
    let b = 0;
    let a: number | null = null;
    if (value.length === 3 || value.length === 4) {
      r = parseInt(value[0] + value[0], 16);
      g = parseInt(value[1] + value[1], 16);
      b = parseInt(value[2] + value[2], 16);
      if (value.length === 4) {
        a = parseInt(value[3] + value[3], 16) / 255;
      }
    } else {
      r = parseInt(value.slice(0, 2), 16);
      g = parseInt(value.slice(2, 4), 16);
      b = parseInt(value.slice(4, 6), 16);
      if (value.length === 8) {
        a = parseInt(value.slice(6, 8), 16) / 255;
      }
    }

    if ([r, g, b].some((n) => Number.isNaN(n))) {
      return null;
    }
    if (a === null || a >= 1) {
      return `rgb(${r}, ${g}, ${b})`;
    }
    return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  }

  private isIgnorableColor(color: string): boolean {
    return (
      color === "rgba(0, 0, 0, 0)" ||
      color === "transparent" ||
      color === "inherit"
    );
  }

  private normalizeFontFamily(value: string): string | null {
    const cleaned = value
      .split(",")
      .map((item) => item.replace(/["']/g, "").trim().toLowerCase())
      .find(Boolean);
    return cleaned ?? null;
  }

  private normalizeExternalUrl(value: string): string {
    const raw = value.trim();
    if (!raw) {
      return "";
    }

    try {
      const candidate = new URL(raw);
      if (!["http:", "https:"].includes(candidate.protocol)) {
        return "";
      }
      return candidate.toString();
    } catch {
      return "";
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
