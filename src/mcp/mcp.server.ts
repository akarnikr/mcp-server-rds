import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";

import { CacheService } from "../common/cache.service.js";
import { ScraperService } from "../scraper/scraper.service.js";
import type { ParsedComponentData } from "../scraper/types.js";

@Injectable()
export class McpServerService implements OnApplicationShutdown {
  private server: Server;
  private sseTransport: SSEServerTransport | null = null;

  constructor(
    private readonly scraperService: ScraperService,
    private readonly cacheService: CacheService,
  ) {
    this.server = this.createServer();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.closeSseTransport();
    await this.closeServer();
  }

  async connectStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async openSseConnection(res: Response): Promise<void> {
    if (this.sseTransport) {
      await this.closeSseTransport();
      await this.closeServer();
      this.server = this.createServer();
    }

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

  private createServer(): Server {
    const server = new Server(
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
    this.registerHandlers(server);
    return server;
  }

  private registerHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "list_rds_components",
            description: "Returns the list of available RDS components.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "generate_rds_component",
            description:
              "Returns source code and props data for a requested RDS component.",
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
            description: "Forces a full live scrape and refreshes local cache.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "get_component_details",
            description:
              "Returns full metadata for one RDS component from docs/cache/npm.",
            inputSchema: {
              type: "object",
              properties: {
                component: { type: "string" },
              },
              required: ["component"],
              additionalProperties: false,
            },
          },
        ],
      };
    });

    server.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest) => {
        try {
          const { name, arguments: args } = request.params;

          if (name === "list_rds_components") {
            const run = await this.scraperService.getRdsData();
            const result = {
              components: run.data.components,
              fromCache: run.fromCache,
              updatedAt: run.data.updatedAt,
              warnings: run.warnings,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          if (name === "generate_rds_component") {
            const componentId =
              typeof args?.componentId === "string" ? args.componentId : "";
            const normalizedId = this.normalizeComponentId(componentId);
            if (!normalizedId) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "Invalid componentId. Expected a non-empty slug string.",
                  },
                ],
              };
            }

            const parsed = await this.findComponentDetails(normalizedId);
            if (!parsed) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Unknown componentId: ${normalizedId}`,
                  },
                ],
              };
            }

            const result = this.formatComponentBlob(parsed);
            return {
              content: [{ type: "text", text: result }],
            };
          }

          if (name === "refresh_rds_cache") {
            const run = await this.scraperService.getRdsData({ forceRefresh: true });
            const result = {
              componentsDiscovered: run.data.components.length,
              componentsParsed: Object.keys(run.data.detailsById).length,
              cachePath: this.cacheService.cachePath,
              refreshedAt: run.data.updatedAt,
              durationMs: run.durationMs,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          if (name === "get_component_details") {
            const component =
              typeof args?.component === "string" ? args.component : "";
            const result = await this.scraperService.getComponentMetadata(component);
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          return {
            isError: true,
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
          };
        } catch (error) {
          console.error("Tool execution failed:", error);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Tool execution failed. See server logs for details.",
              },
            ],
          };
        }
      },
    );
  }

  private async closeSseTransport(): Promise<void> {
    if (!this.sseTransport) {
      return;
    }

    try {
      if ("close" in this.sseTransport) {
        await (this.sseTransport as { close: () => Promise<void> }).close();
      }
    } catch (error) {
      console.error("Failed to close SSE transport during shutdown:", error);
    } finally {
      this.sseTransport = null;
    }
  }

  private async closeServer(): Promise<void> {
    try {
      if ("close" in this.server) {
        await (this.server as { close: () => Promise<void> }).close();
      }
    } catch (error) {
      console.error("Failed to close MCP server during shutdown:", error);
    }
  }

  private async findComponentDetails(
    componentId: string,
  ): Promise<ParsedComponentData | null> {
    const result = await this.scraperService.getComponentDetails(componentId);
    return result.parsed;
  }

  private normalizeComponentId(input: string): string {
    return input.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  }

  private formatComponentBlob(component: ParsedComponentData): string {
    const lines: string[] = [];
    lines.push(`# ${component.componentId}`);
    lines.push(`URL: ${component.url}`);
    lines.push("");
    lines.push("## Source Code");
    if (component.sourceCode) {
      lines.push("```vue");
      lines.push(component.sourceCode);
      lines.push("```");
    } else {
      lines.push("No source code found.");
    }
    lines.push("");
    lines.push("## Props");
    if (component.propsColumns.length > 0 && component.propsRows.length > 0) {
      lines.push(this.toMarkdownTable(component.propsColumns, component.propsRows));
    } else {
      lines.push("No props data found.");
    }

    if (component.warnings && component.warnings.length > 0) {
      lines.push("");
      lines.push("## Warnings");
      for (const warning of component.warnings) {
        lines.push(`- ${warning}`);
      }
    }

    return lines.join("\n");
  }

  private toMarkdownTable(
    columns: string[],
    rows: Array<Record<string, string>>,
  ): string {
    const safeColumns = columns.map((column) => this.escapePipe(column));
    const header = `| ${safeColumns.join(" | ")} |`;
    const separator = `| ${safeColumns.map(() => "---").join(" | ")} |`;

    const body = rows.map((row) => {
      const cells = columns.map((column) => this.escapePipe(row[column] ?? ""));
      return `| ${cells.join(" | ")} |`;
    });

    return [header, separator, ...body].join("\n");
  }

  private escapePipe(value: string): string {
    return value.replace(/\|/g, "\\|");
  }
}
