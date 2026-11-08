#!/usr/bin/env node
// stdio entry (`orca-mcp` bin): one server per MCP client session.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOrcaMcpServer } from "./mcp-server.js";
import { killAllOrcaChildren } from "./orca.js";

const server = createOrcaMcpServer();
await server.connect(new StdioServerTransport());

// The client ends this server by closing stdin or with a signal; orca calls still in
// flight lead their own process groups and would outlive it.
const exit = () => {
  killAllOrcaChildren();
  process.exit(0);
};
process.stdin.on("close", exit);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, exit);
