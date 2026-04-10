# Implementation Phases

This document breaks implementation into 4 executable phases. It is derived from:
- `docs/PRD.md`
- `docs/IMPLEMENTATION_SPEC.md`

## Phase Files
- `docs/PHASE_1_BOOTSTRAP_AND_TRANSPORT.md`
- `docs/PHASE_2_SCRAPER_AND_CACHE.md`
- `docs/PHASE_3_PARSER_AND_TOOLS.md`
- `docs/PHASE_4_HARDENING_AND_VERIFICATION.md`

## Sequence and Exit Gates
1. Complete Phase 1 and pass all exit criteria before Phase 2.
2. Complete Phase 2 and pass all exit criteria before Phase 3.
3. Complete Phase 3 and pass all exit criteria before Phase 4.
4. Complete Phase 4 to reach implementation-ready and review-ready status.

## Cross-Phase Invariants
- `console.error` is used for operational logging; stdout remains protocol-clean.
- Browser lifecycle is explicit and leak-safe; contexts/pages are always closed.
- Tool contracts remain stable:
  - `list_rds_components`
  - `generate_rds_component`
  - `refresh_rds_cache`
- Cache path and TTL remain fixed:
  - `.cache/rds-data.json`
  - 24 hours
