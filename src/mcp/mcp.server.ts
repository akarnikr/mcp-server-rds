import { Injectable } from "@nestjs/common";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";

import { generateRdsComponentTool } from "./tools/generate-rds-component.tool.js";
import { listRdsComponentsTool } from "./tools/list-rds-components.tool.js";
import { refreshRdsCacheTool } from "./tools/refresh-rds-cache.tool.js";

@Injectable()
export class McpServerService {
  private readonly server: Server;
  private sseTransport: SSEServerTransport | null = null;

  constructor() {
    this.server = new Server(
      {
        name: "mcp-server-rds",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.registerHandlers();
  }

  async connectStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async openSseConnection(res: Response): Promise<void> {
    this.sseTransport = new SSEServerTransport("/mcp/messages", res);
    await this.server.connect(this.sseTransport);
  }

  async handleSseMessage(req: Request, res: Response): Promise<void> {
    if (!this.sseTransport) {
      res.status(400).json({
        error: "No active SSE session. Open GET /mcp first.",
      });
      return;
    }

    await this.sseTransport.handlePostMessage(req, res);
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "list_rds_components",
            description: "List available RDS components (Phase 1 stub).",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "generate_rds_component",
            description: "Generate RDS component usage (Phase 1 stub).",
            inputSchema: {
              type: "object",
              properties: {
                componentId: { type: "string" },
              },
              required: ["componentId"],
              additionalProperties: false,
            },
          },
          {
            name: "refresh_rds_cache",
            description: "Refresh RDS cache (Phase 1 stub).",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest) => {
        const { name, arguments: args } = request.params;

        if (name === "list_rds_components") {
          const result = listRdsComponentsTool();
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        if (name === "generate_rds_component") {
          const componentId =
            typeof args?.componentId === "string" ? args.componentId : "";
          const result = generateRdsComponentTool({ componentId });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        if (name === "refresh_rds_cache") {
          const result = refreshRdsCacheTool();
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
      },
    );
  }
}
