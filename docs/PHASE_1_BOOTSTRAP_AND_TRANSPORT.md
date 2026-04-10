# Phase 1: Bootstrap and Transport

## Objective
Establish a working NestJS MCP server skeleton with dual transport support (`stdio` + `sse`) and tool registration stubs.

## Implementation Tasks
1. Create project baseline:
- `package.json` with `mcp-server-rds`, Yarn scripts, Node `22.x` engine.
- `tsconfig.json` and TypeScript build settings.
- dependency set for NestJS `10.4.22`, MCP SDK `2.x`, Playwright.

2. Scaffold server modules:
- `src/main.ts`
- `src/app.module.ts`
- `src/mcp/mcp.module.ts`
- `src/mcp/mcp.server.ts`
- tool placeholder files under `src/mcp/tools/`

3. Implement dual transport bootstrap:
- `MCP_MODE=sse` starts HTTP app with SSE transport.
- default starts MCP with stdio transport.
- SSE defaults:
  - host `127.0.0.1`
  - port `3001`
  - path `/mcp`

## Deliverables
- Compilable project skeleton with transport mode switching.
- Registered placeholder MCP tools:
  - `list_rds_components`
  - `generate_rds_component`
  - `refresh_rds_cache`
  - `get_component_details`

## Exit Criteria
- App builds without TypeScript errors.
- Stdio mode starts without contaminating stdout logs.
- SSE mode binds expected endpoint (`127.0.0.1:3001/mcp`).
- MCP tool registration is visible in startup/runtime behavior.

## Risks and Notes
- Keep stdout clean from day 1 to avoid protocol issues.
- Avoid adding behavior-specific logic in Phase 1 beyond transport/tool wiring.
