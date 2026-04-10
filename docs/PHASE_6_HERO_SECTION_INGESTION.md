# Phase 6: Hero Section Ingestion (Docs + Primary + Examples)

## Objective
Add first-class ingestion for `Sections/Hero/*` from RDS Storybook so Hero sections are queryable via MCP with cache-first behavior, stale fallback, and deterministic section IDs.

## Scope
- In-scope: `Sections/Hero` only for this phase.
- Covered variants per section: `--docs`, `--primary`, `--examples`.
- Out-of-scope: non-Hero sections and any breaking changes to component APIs.

## Implementation Tasks
1. Add section MCP tools:
- `list_rds_sections` with optional input `{ category?: string }`.
- `get_section_details` with input `{ section: string }`.

2. Extend cache/data contracts:
- Add `sections.index` and `sections.detailsById` under cached data.
- Canonical section ID: slug from title leaf (example: `HeroStandardApollo` -> `hero-standard-apollo`).
- Bump cache schema version by +1 to invalidate incompatible cache.

3. Implement Hero discovery and grouping:
- Source: Storybook `index.json`.
- Filter `title` that starts with `Sections/Hero/`.
- Include and group `--docs`, `--primary`, `--examples` under canonical section ID.

4. Implement scrape + parse:
- Reuse docs scrape/parser path for `--docs`.
- Capture story metadata links for `--primary` and `--examples`.
- Build section metadata payload with:
  - identity (`name`, `sectionId`, `category`)
  - docs payload (`sourceCode`, `propsColumns`, `propsRows`, warnings)
  - story/variant references
  - source metadata (`indexJsonUrl`, `fetchedAt`, `fromCache`)
  - completeness score and warnings

5. Integrate with refresh flow:
- Include section ingestion during `refresh_rds_cache`.
- Extend refresh summary with:
  - `sectionsDiscovered`
  - `sectionsParsed`

## Tool Contracts

### `list_rds_sections`
- Input:
```ts
{ category?: string }
```
- Output:
```ts
{
  sections: Array<{
    sectionId: string;
    title: string;
    category: string;
    docsUrl: string;
  }>;
  fromCache: boolean;
  updatedAt: string;
  warnings: string[];
}
```

### `get_section_details`
- Input:
```ts
{ section: string }
```
- Output:
```ts
{
  name: string;
  sectionId: string;
  category: "hero";
  description: string | null;
  docs: {
    storyId: string;
    url: string;
    sourceCode: string | null;
    propsColumns: string[];
    propsRows: Array<Record<string, string>>;
    warnings?: string[];
  } | null;
  stories: Array<{
    id: string;
    name: string;
    type: string;
    url: string;
  }>;
  variants: {
    primary: { id: string; url: string } | null;
    examples: { id: string; url: string } | null;
  };
  sourceMeta: {
    indexJsonUrl: string;
    fetchedAt: string;
    fromCache: boolean;
  };
  metadataCompleteness: {
    score: number;
    missing: string[];
  };
  warnings: string[];
}
```
- Error:
```ts
{ error: "Section not found: <input>" }
```

## Cache and Failure Behavior
- Fresh cache is used first (24h TTL).
- Live scrape runs on stale/missing cache.
- If live scrape fails and stale section cache exists, stale data is returned with warning metadata.
- If no fallback exists, return tool error.

## Testing and Acceptance
1. Discovery:
- Hero section discovery returns expected IDs:
  - `hero-article-atlas`
  - `hero-standard-apollo`
  - `hero-video-apollo`

2. Tool behavior:
- `list_rds_sections` returns Hero list with metadata.
- `get_section_details("hero-standard-apollo")` returns docs + primary + examples references.
- Unknown section returns explicit not-found error.

3. Refresh behavior:
- `refresh_rds_cache` includes section counters and persists section cache.

4. Resilience:
- Stale fallback works for section ingestion errors.
- Existing tools remain unchanged and functional.

## Deliverables
- New phase doc (this file).
- Decision-complete spec for Hero section ingestion, cache, and MCP APIs.
