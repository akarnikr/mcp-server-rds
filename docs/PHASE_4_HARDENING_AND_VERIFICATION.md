# Phase 4: Hardening and Verification

## Objective
Harden operational behavior, guarantee cleanup/logging requirements, and validate end-to-end correctness.

## Implementation Tasks
1. Lifecycle and cleanup:
- implement `onApplicationShutdown` browser teardown
- ensure no hanging Playwright resources

2. Logging policy enforcement:
- use `console.error` for operational logging
- keep stdout reserved for MCP protocol transport

3. Validation and quality checks:
- run typecheck and build
- run smoke checks for both transports:
  - stdio mode startup + tool invocation sanity
  - SSE mode startup at `127.0.0.1:3001/mcp`
- verify stale-cache fallback and error messages

4. Contract conformance review:
- verify behavior against:
  - `docs/PRD.md`
  - `docs/IMPLEMENTATION_SPEC.md`
  - phase criteria from this phase pack

## Deliverables
- Stable implementation with cleanup and logging guarantees.
- Verification evidence that key scenarios pass.

## Exit Criteria
- No critical runtime errors in startup/shutdown flows.
- Browser closes cleanly on shutdown.
- Tool behavior and response shapes align with approved docs.
- Both transport modes are functional.

## Risks and Notes
- Shutdown race conditions may appear if active scrapes are in flight.
- Keep error messages concise and actionable for MCP clients.
