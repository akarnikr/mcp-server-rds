# Implementation Specification

## 1. Overview
This document defines a decision-complete implementation for `mcp-server-rds` using NestJS + MCP SDK + Playwright.

## 2. Target Project Structure

```text
mcp-server-rds/
├── .cache/
├── docs/
│   ├── PRD.md
│   └── IMPLEMENTATION_SPEC.md
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── mcp/
│   │   ├── mcp.module.ts
│   │   ├── mcp.server.ts
│   │   └── tools/
│   │       ├── list-rds-components.tool.ts
│   │       ├── generate-rds-component.tool.ts
│   │       └── refresh-rds-cache.tool.ts
│   ├── scraper/
│   │   ├── scraper.module.ts
│   │   ├── scraper.service.ts
│   │   └── parser.service.ts
│   └── common/
│       └── cache.service.ts
├── package.json
└── tsconfig.json
```

## 3. Runtime and Bootstrap

## 3.1 `main.ts`
- Read `process.env.MCP_MODE`.
- If value is `sse`, start Nest HTTP app and bind MCP via `SSEServerTransport`.
- Otherwise start MCP via `StdioServerTransport` in local process mode.

## 3.2 SSE defaults
- Host: `127.0.0.1`
- Port: `3001`
- Path: `/mcp`
- Optional env overrides may be supported, but defaults above must apply when unset.

## 4. Module Responsibilities

## 4.1 `AppModule`
- Imports `McpModule`, `ScraperModule`.

## 4.2 `McpModule`
- Provides MCP server initializer (`mcp.server.ts`).
- Registers 6 tools:
  - `list_rds_components`
  - `generate_rds_component`
  - `refresh_rds_cache`
  - `get_component_details`
  - `get_base_theme_guidelines`
  - `validate_theme_compliance`

## 4.3 `ScraperModule`
- Provides `ScraperService`, `ParserService`, `CacheService`.

## 4.4 `CacheService` (`src/common/cache.service.ts`)
- File path: `.cache/rds-data.json`.
- API contract:
  - `readCache(): CachedRdsData | null`
  - `writeCache(data: CachedRdsData): Promise<void>`
  - `isFresh(updatedAtIso: string, ttlHours = 24): boolean`
  - `getFreshCache(ttlHours = 24): CachedRdsData | null`

## 5. Data Contracts

## 5.1 Component record
```ts
type RdsComponentRecord = {
  componentId: string; // slug
  title: string;
  url: string;
};
```

## 5.2 Parsed component details
```ts
type ParsedComponentData = {
  componentId: string;
  url: string;
  sourceCode: string | null;
  installCommand: string | null;
  propsColumns: string[]; // all visible table headers
  propsRows: Array<Record<string, string>>; // dynamic per header
  warnings?: string[];
};
```

## 5.3 Cache document
```ts
type CachedRdsData = {
  schemaVersion: number;
  updatedAt: string; // ISO
  sourceSite: string; // https://rds-vue-ui.edpl.us/
  components: RdsComponentRecord[];
  detailsById: Record<string, ParsedComponentData>;
  themes?: {
    baseTheme: BaseThemeGuidelines;
  };
};
```

## 6. Scraper Behavior (`scraper.service.ts`)

## 6.1 Discovery
- Open docs root.
- Crawl docs nav links and keep component pages.
- Normalize to slug `componentId`.
- Remove duplicates by slug.

## 6.2 Batched scrape
- Batch size fixed to 3 URLs.
- For each batch:
  - run `Promise.all` on URLs in the batch.
  - each URL uses dedicated `browser.newContext()`.
  - `page.goto(url, { waitUntil: 'networkidle', timeout: 20000 })`.
  - pass HTML/content to parser.
  - close page + context in `finally`.
- After each batch, wait 1 second before next batch.

## 6.3 Memory safety and lifecycle
- Keep one browser instance per refresh run.
- Avoid retaining raw HTML once parsed.
- On application shutdown, close browser if open.

## 6.4 Failure handling
- If a page fails: collect warning and continue remaining pages.
- If entire refresh fails:
  - return stale cache when available and mark warning metadata.
  - throw error only when no stale cache exists.

## 7. Parser Behavior (`parser.service.ts`)

## 7.1 Source code extraction
- Prefer first Vue code block (for example `language-vue`, `lang-vue`, Vue-marked example).
- If no Vue block found, fall back to first code block and add warning.
- If no code block exists, set `sourceCode = null` and add warning.

## 7.2 Props extraction
- Locate props table section.
- Parse all visible headers as `propsColumns`.
- Parse each row into dynamic key/value record.
- Preserve displayed text order and values as strings.

## 7.3 Generate raw text blob format
`generate_rds_component` response body string format:
- Header line with component id and URL
- `Source Code` section fenced as Vue when present
- `Props` section as markdown table using parsed dynamic columns
- `Warnings` section when applicable

## 8. MCP Tool Contracts

## 8.1 `list_rds_components`
- Input: none
- Behavior:
  - use fresh cache if present
  - else run scrape/discovery and cache result
- Output:
  - list of `{ componentId, title, url }`
  - include metadata: `fromCache`, `updatedAt`

## 8.2 `generate_rds_component`
- Input schema:
```ts
{ componentId: string }
```
- Behavior:
  - normalize slug
  - ensure component details available (cache first, scrape on miss)
  - return raw text blob only
- Errors:
  - invalid/unknown slug => tool error with clear message
  - scrape failure with no fallback => tool error

## 8.3 `refresh_rds_cache`
- Input: none
- Behavior:
  - force bypass freshness checks
  - run full discovery + scrape + cache write
- Output JSON:
```ts
{
  componentsDiscovered: number;
  componentsParsed: number;
  cachePath: string;
  refreshedAt: string;
  durationMs: number;
}
```

## 8.4 `get_component_details`
- Input schema:
```ts
{ component: string }
```
- Behavior:
  - normalize/resolve component id
  - fetch parsed docs details (cache-first with live scrape fallback)
  - enrich with story index and npm registry metadata
  - return JSON metadata object; return `{ error: string }` when unresolved
- Output JSON shape:
```ts
type RdsComponentMetadata = {
  name: string;
  package: string | null;
  version: string | null;
  description: string | null;
  category: string | null;
  props: Array<Record<string, string>>;
  events: Array<Record<string, string>>;
  slots: Array<Record<string, string>>;
  stories: Array<{ id: string; title: string; url: string; type: string }>;
  peerDependencies: Record<string, string>;
  lastPublished: string | null;
  importStatement: string | null;
  installCommand: string | null;
  sourceMeta: {
    docsUrl: string | null;
    indexJsonUrl: string;
    npmRegistryUrl: string | null;
    fetchedAt: string;
    fromCache: boolean;
  };
  metadataCompleteness: {
    score: number;
    missing: string[];
  };
  warnings: string[];
};
```

## 8.5 `get_base_theme_guidelines`
- Input: none
- Behavior:
  - resolve fresh cache theme payload when available
  - otherwise scrape Storybook `index.json` for `Foundations/Base Theme` story ids
  - scrape corresponding `iframe.html?id=<storyId>&viewMode=story` pages
  - extract CSS variables/text/color values/typography families and persist in cache
- Output JSON:
```ts
{
  baseTheme: BaseThemeGuidelines;
  fromCache: boolean;
  updatedAt: string;
  warnings: string[];
}
```

## 8.6 `validate_theme_compliance`
- Input schema:
```ts
{ url: string }
```
- Behavior:
  - validate absolute `http`/`https` URL
  - load base theme guidelines (cache-first)
  - scan target page computed styles via Playwright
  - validate colors and font families against base theme reference sets
- Output:
```ts
type ThemeComplianceReport = {
  url: string;
  checkedAt: string;
  fromThemeCache: boolean;
  summary: {
    totalElementsScanned: number;
    totalViolations: number;
    score: number; // 0..1
    compliant: boolean;
  };
  checks: Array<{ id: string; status: "pass" | "fail"; message: string }>;
  violations: Array<{
    type: "color" | "typography";
    property: string;
    value: string;
    element: string;
    message: string;
  }>;
  warnings: string[];
  themeReference: {
    storyCount: number;
    storyIds: string[];
    updatedAt: string;
  };
};
```

## 9. Logging and Error Policy
- All logs must use `console.error`.
- Do not print operational logs to stdout.
- Tool errors should be concise and actionable.

## 10. Package/Build Specification
- Package name: `mcp-server-rds`
- Package manager: Yarn
- Node engine: `22.x`
- Required dependency families:
  - NestJS 10.4.22 core packages
  - `@modelcontextprotocol/sdk` 2.x
  - `playwright`
  - utility deps for validation/parsing as needed
- Scripts include:
  - `build`, `start`, `start:dev`, `lint`, `typecheck`

## 11. Test and Verification Plan

## 11.1 Unit tests
- Cache freshness logic (fresh/stale boundaries).
- Parser extraction:
  - first Vue block preference
  - dynamic props columns/rows parsing
  - warning paths
- slug normalization behavior.

## 11.2 Integration tests
- `list_rds_components` returns non-empty list using mocked docs HTML.
- `generate_rds_component` returns raw text blob with code and props.
- `refresh_rds_cache` returns summary JSON and writes cache.
- `get_component_details` returns enriched metadata for a valid component.
- `get_base_theme_guidelines` returns base theme payload from cache/live scrape.
- `validate_theme_compliance` returns pass/fail report for valid URL input.

## 11.3 Runtime checks
- Stdio mode launches with clean stdout protocol behavior.
- SSE mode binds `127.0.0.1:3001/mcp`.
- Shutdown closes browser without unhandled rejections.

## 12. Defaults and Assumptions
- `componentId` is slug-only external contract.
- Source site is `https://rds-vue-ui.edpl.us/`.
- Stale-cache fallback is allowed only when stale cache exists.
- Dynamic props table keys are preserved exactly as displayed in docs.
