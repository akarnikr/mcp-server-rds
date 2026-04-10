import { Injectable } from "@nestjs/common";
import { chromium } from "playwright";

import { CacheService } from "../common/cache.service.js";
import { ParserService } from "./parser.service.js";
import type {
  CachedRdsData,
  RdsComponentRecord,
  ScrapeRunResult,
  ScrapedPagePayload,
} from "./types.js";

const DOCS_ROOT_URL = "https://rds-vue-ui.edpl.us/";
const INDEX_JSON_URL = new URL("index.json", DOCS_ROOT_URL).toString();
const NAV_PATH_FRAGMENT = "/components/";
const BATCH_SIZE = 3;
const INTER_BATCH_DELAY_MS = 1000;
const PAGE_TIMEOUT_MS = 20_000;

@Injectable()
export class ScraperService {
  constructor(
    private readonly cacheService: CacheService,
    private readonly parserService: ParserService,
  ) {}

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

  private async runLiveRefresh(startedAt: number): Promise<ScrapeRunResult> {
    const staleCache = await this.cacheService.readCache();

    try {
      const browser = await chromium.launch({ headless: true });
      try {
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
      } finally {
        await browser.close();
      }
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
      const html = await page.content();

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
}
