# Product Requirements Document (PRD)

## Project
MCP Server for Rocket Design System (RDS) Vue component docs: <https://rds-vue-ui.edpl.us/>

## Problem Statement
AI agents need a reliable way to discover RDS components and generate usage code from live documentation without manual browsing.

## Goal
Provide an MCP server that exposes tools for:
- listing available RDS components
- generating component code and props details from docs
- refreshing a local cache from live docs
- returning enriched component metadata from docs/cache/npm

## Audience
- AI assistants and agent workflows using MCP
- Developers integrating RDS component generation into AI-enabled tooling

## Non-Goals
- Hosting an RDS mirror site
- Editing upstream docs
- Supporting non-Vue frameworks in v1

## Functional Requirements

### 1) `list_rds_components`
- Returns all discovered RDS components.
- Component discovery is automatic via docs navigation crawling.
- Uses cache when valid (under 24 hours old), unless forced refresh is requested via refresh tool.

### 2) `generate_rds_component`
- Input: `componentId` as slug (example: `button`).
- Normalizes slug and resolves matching component docs URL.
- Scrapes target page and returns:
  - first Vue code example on the page
  - props table parsed from all visible columns
- Output format: raw text blob (single formatted string).

### 3) `refresh_rds_cache`
- Bypasses cache freshness checks and reruns live scrape.
- Returns summary JSON:
  - `componentsDiscovered`
  - `componentsParsed`
  - `cachePath`
  - `refreshedAt`
  - `durationMs`

### 4) `get_component_details`
- Input: `component` as slug-like identifier (example: `button`).
- Resolves canonical component id, then assembles metadata from docs/cache/npm sources.
- Returns JSON with:
  - component identity (`name`, `package`, `version`, `description`, `category`)
  - docs-derived API shape (`props`, plus currently empty `events` and `slots`)
  - story discovery (`stories`)
  - npm metadata (`peerDependencies`, `lastPublished`, `importStatement`, `installCommand`)
  - source metadata (`sourceMeta`)
  - completeness scoring (`metadataCompleteness`)
  - warnings list (`warnings`)

## Scraping and Performance Requirements
- Use Playwright Chromium.
- Do not block fonts/images/assets; page must fully load brand assets.
- Use `page.goto(url, { waitUntil: 'networkidle', timeout: 20000 })`.
- Scrape in batches of 3 URLs with parallel processing via `Promise.all`.
- Isolate each URL in a dedicated browser context; close context immediately after parse.
- Wait 1 second between batches to reduce CPU pressure.

## Caching Requirements
- Cache file path: `.cache/rds-data.json`.
- Cache TTL: 24 hours.
- If refresh fails, serve stale cache when available, with warning metadata.

## Runtime/Transport Requirements
- Dual mode startup:
  - `MCP_MODE=sse` => HTTP server with SSE transport
  - otherwise => stdio transport
- SSE defaults:
  - host: `127.0.0.1`
  - port: `3001`
  - path: `/mcp`

## Reliability and Operations
- Use `console.error` for logs (stdout reserved for MCP protocol).
- Ensure Playwright browser shutdown via application lifecycle hook (`onApplicationShutdown`).

## Tech Constraints
- NestJS `10.4.22`
- `@modelcontextprotocol/sdk` `2.x`
- TypeScript
- Package manager: Yarn
- Node.js target: 22 LTS
- Package name: `mcp-server-rds`

## Success Criteria
- MCP client can list components from live docs using cache-aware behavior.
- MCP client can request component generation by slug and get code+props blob.
- Cache refresh runs in batched mode and reports summary JSON.
- MCP client can request enriched component metadata by component id.
- Server supports both stdio and SSE startup modes.
- Scraper cleans up contexts/browser and does not leak resources across requests.

## Acceptance Checklist
- [ ] All four MCP tools are implemented and callable.
- [ ] Cache freshness and forced refresh logic works as specified.
- [ ] Batch size, delay, timeout, and context lifecycle requirements are met.
- [ ] SSE defaults and stdio fallback behavior are implemented.
- [ ] Logging and shutdown behavior follow requirements.
