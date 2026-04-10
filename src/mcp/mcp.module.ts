import { Module } from "@nestjs/common";

import { McpServerService } from "./mcp.server.js";

@Module({
  providers: [McpServerService],
  exports: [McpServerService],
})
export class McpModule {}
