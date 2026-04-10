import { Module } from "@nestjs/common";

import { ScraperModule } from "../scraper/scraper.module.js";
import { McpServerService } from "./mcp.server.js";

@Module({
  imports: [ScraperModule],
  providers: [McpServerService],
  exports: [McpServerService],
})
export class McpModule {}
