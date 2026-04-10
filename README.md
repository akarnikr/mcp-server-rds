# MCP Server for RDS Vue UI

NestJS-based MCP server for the Rocket Design System (RDS) Vue docs. It lets AI tools discover available RDS components and generate Vue usage snippets from live documentation with cache-backed scraping.

## MCP Tools
- `list_rds_components`: Returns discovered RDS components from fresh cache or live scrape.
- `generate_rds_component`: Returns a raw text blob containing source code and props for one component.
- `refresh_rds_cache`: Forces a full live scrape and refreshes local cache.
- `get_component_details`: Returns enriched metadata for one component (docs/cache/npm), including install/import details.
- `list_rds_sections`: Returns discovered RDS sections (Hero category in Phase 6).
- `get_section_details`: Returns enriched metadata for a section slug (Hero category in Phase 6).
- `get_base_theme_guidelines`: Returns cached/scraped Foundations Base Theme guidelines from Storybook.
- `validate_theme_compliance`: Validates a webpage URL against RDS base theme palette and typography families.
