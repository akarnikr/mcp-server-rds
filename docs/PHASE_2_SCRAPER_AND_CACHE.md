# Phase 2: Scraper and Cache Core

## Objective
Implement reliable component discovery and batched scraping with persistent 24-hour disk cache and stale-data fallback.

## Implementation Tasks
1. Add scraper and cache modules/services:
- `src/scraper/scraper.module.ts`
- `src/scraper/scraper.service.ts`
- `src/common/cache.service.ts`

2. Implement component discovery:
- crawl RDS docs navigation from `https://rds-vue-ui.edpl.us/`
- detect component page links
- normalize slug `componentId`
- de-duplicate by slug

3. Implement batched scraping strategy:
- fixed batch size = 3 URLs
- process each batch via `Promise.all`
- per URL:
  - create isolated browser context
  - `page.goto(url, { waitUntil: 'networkidle', timeout: 20000 })`
  - collect page content for parser handoff
  - always close page/context in `finally`
- add 1-second delay between batches

4. Implement cache behavior:
- file: `.cache/rds-data.json`
- read/write JSON payload
- freshness check for 24h TTL
- stale fallback if refresh fails and stale cache exists

## Deliverables
- Discovery + scrape path that produces cache payload.
- Cache freshness and forced-refresh support primitives available for MCP tools.

## Exit Criteria
- Cache file is created and reused when fresh.
- Forced refresh path bypasses freshness check.
- On scrape failure with stale cache present, stale cache is returned with warning metadata.
- No context/page leaks observed across batches.

## Risks and Notes
- Docs structure changes can affect nav extraction selectors.
- Asset-heavy pages may stress CPU/memory; keep batch and delay fixed.
