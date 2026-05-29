import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Wire a Koa app that exposes the MCP server over streamable HTTP at POST /mcp.
 *
 * Stateless mode (no session id): a fresh MCP server + transport is created per
 * request, which is enough for a single local client.
 */
export function createHttpServer(createMcp: () => McpServer): Koa {
  const app = new Koa();
  const router = new Router();

  router.post("/mcp", async (ctx) => {
    // Hand the raw Node res to the transport; Koa must not also respond.
    ctx.respond = false;

    const server = createMcp();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    ctx.res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(ctx.req, ctx.res, ctx.request.body);
  });

  // Stateless mode does not support the SSE GET stream or session deletion.
  const methodNotAllowed = (ctx: Koa.Context) => {
    ctx.status = 405;
    ctx.body = {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    };
  };
  router.get("/mcp", methodNotAllowed);
  router.delete("/mcp", methodNotAllowed);

  app.use(bodyParser());
  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}
