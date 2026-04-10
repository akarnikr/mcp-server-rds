# Phase 5: Theme Guidelines and Compliance

## Objective
Scrape and cache RDS Storybook Base Theme guidance, then expose machine-readable compliance validation for project webpages.

## Implementation Tasks
1. Add base-theme scrape pipeline:
- discover `Foundations/Base Theme` stories from Storybook `index.json`
- scrape each `foundations-base-theme--*` story iframe
- extract CSS variables, color values, typography families, and guideline text

2. Extend cache contract:
- persist extracted data under `themes.baseTheme`
- bump cache schema version and invalidate older cache automatically

3. Add MCP guideline retrieval tool:
- `get_base_theme_guidelines`
- return structured base-theme guidance with cache/live metadata and warnings

4. Add MCP compliance validation tool:
- `validate_theme_compliance` with input `{ url: string }`
- scan computed styles on target page
- validate color/background/border and font-family usage against base-theme references
- return summary score, checks, and violation details

## Deliverables
- Stable base-theme guideline extraction and cache persistence.
- MCP tooling for both guideline retrieval and compliance validation.
- Updated docs/spec/PRD for tool contracts and cache shape.

## Exit Criteria
- Base theme stories are discovered and cached with reproducible output.
- `get_base_theme_guidelines` returns cache-first payload with fallback warnings.
- `validate_theme_compliance` returns deterministic pass/fail checks and violations for valid URLs.
- Existing component tools continue functioning without regressions.

## Risks and Notes
- Storybook markup/CSS variable naming may evolve; parser should be warning-tolerant.
- Compliance currently enforces palette and typography families; spacing/grid checks remain advisory in v1.
