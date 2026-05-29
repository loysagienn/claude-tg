import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface ToolDeps {
  /** Send a text message to the configured user. */
  sendMessage: (text: string) => Promise<void>;
}

/**
 * Build a fresh MCP server with the Telegram tools registered.
 *
 * In stateless streamable-HTTP mode a new server instance is created per
 * request, so this is a factory rather than a singleton.
 */
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "telegram-mcp", version: "0.1.0" });

  server.registerTool(
    "tg_send_message",
    {
      title: "Send Telegram message",
      description: "Send a text message to the configured user via Telegram.",
      inputSchema: {
        text: z.string().min(1).describe("The message text to send"),
      },
    },
    async ({ text }) => {
      await deps.sendMessage(text);
      return { content: [{ type: "text", text: "Message sent." }] };
    },
  );

  return server;
}
