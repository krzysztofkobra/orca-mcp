import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildTools, type ToolDeps } from "./tools.js";

export const VERSION = "0.1.1";

/**
 * An MCP server with every Orca tool registered. Embedders pass their own deps
 * (`onToolResult`, a runner, an env); the client tag defaults to the MCP
 * client's name from initialize.
 */
export function createOrcaMcpServer(deps: ToolDeps = {}): McpServer {
  const server = new McpServer({ name: "orca", version: VERSION });
  for (const t of buildTools({ client: () => server.server.getClientVersion()?.name, ...deps })) {
    // Each handler's argument type is exactly the shape's parsed type; the SDK validates before calling.
    server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, t.handler as never);
  }
  return server;
}
