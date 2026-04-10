# Phase 3: Parser and MCP Tools

## Objective
Convert scraped docs into structured component data and complete functional behavior of all MCP tools.

## Implementation Tasks
1. Implement parser service:
- `src/scraper/parser.service.ts`
- source code extraction:
  - prefer first Vue code block
  - fallback to first code block with warning
  - return `null` source with warning when no code exists
- props extraction:
  - parse all visible props table headers dynamically
  - map rows to dynamic key-value records

2. Implement tool behavior:
- `list_rds_components`:
  - use fresh cache when available
  - otherwise trigger discovery/scrape flow
  - return component list with metadata (`fromCache`, `updatedAt`)
- `generate_rds_component`:
  - input `{ componentId: string }` (slug only)
  - normalize and resolve component page
  - ensure details present (cache-first, scrape on miss)
  - output raw text blob with source + props + warnings
- `refresh_rds_cache`:
  - bypass freshness checks
  - run full refresh flow
  - return summary JSON fields from approved contract
- `get_component_details`:
  - input `{ component: string }`
  - resolve component id from slug-like input
  - return enriched metadata assembled from docs/cache/npm
  - return `{ error: string }` when unresolved

3. Error semantics:
- unknown slug -> clear tool error
- no stale fallback available on fatal scrape failure -> tool error
- warnings included in output metadata/blob where applicable

## Deliverables
- Parser producing source and dynamic props data.
- Production-behavior MCP tools wired through `mcp.server.ts`, including `get_component_details`.

## Exit Criteria
- Tool outputs match PRD/spec contracts.
- `generate_rds_component` returns raw text blob for valid slug.
- `list_rds_components` and `refresh_rds_cache` return expected metadata and summary fields.
- `get_component_details` returns enriched metadata for valid components.

## Risks and Notes
- Props table schema may vary by component; dynamic column parsing is required.
- Code block labeling may vary; selector strategy should be resilient.
