import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import type { Request, Response } from "express";

import { AppModule } from "./app.module.js";
import { McpServerService } from "./mcp/mcp.server.js";

const SSE_HOST = process.env.MCP_SSE_HOST ?? "127.0.0.1";
const SSE_PORT = Number(process.env.MCP_SSE_PORT ?? 3001);
const SSE_PATH = process.env.MCP_SSE_PATH ?? "/mcp";

async function bootstrap(): Promise<void> {
  const mode = process.env.MCP_MODE;

  if (mode === "sse") {
    const app = await NestFactory.create(AppModule, {
      logger: false,
    });
    app.enableShutdownHooks();
    const mcp = app.get(McpServerService);
    const http = app.getHttpAdapter().getInstance();

    http.get(SSE_PATH, async (_req: Request, res: Response) => {
      try {
        await mcp.openSseConnection(res);
      } catch (error) {
        console.error("Failed to open SSE connection:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to open SSE connection" });
        }
      }
    });

    http.post(`${SSE_PATH}/messages`, async (req: Request, res: Response) => {
      try {
        await mcp.handleSseMessage(req, res);
      } catch (error) {
        console.error("Failed to handle SSE message:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to handle SSE message" });
        }
      }
    });

    await app.listen(SSE_PORT, SSE_HOST);
    console.error(`MCP SSE server listening on http://${SSE_HOST}:${SSE_PORT}${SSE_PATH}`);
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  app.enableShutdownHooks();
  const mcp = app.get(McpServerService);
  await mcp.connectStdio();
  console.error("MCP stdio server connected.");

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`Received ${signal}; shutting down MCP stdio server.`);
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void bootstrap().catch((error: unknown) => {
  console.error("Fatal bootstrap error:", error);
  process.exit(1);
});
