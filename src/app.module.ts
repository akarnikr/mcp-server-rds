import { Module } from "@nestjs/common";

import { McpModule } from "./mcp/mcp.module.js";
import { ScraperModule } from "./scraper/scraper.module.js";

@Module({
  imports: [McpModule, ScraperModule],
})
export class AppModule {}
