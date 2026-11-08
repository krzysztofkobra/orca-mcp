#!/usr/bin/env node
// stdio entry (`orca-mcp` bin): one server per MCP client session.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StatusBridge } from "./bridge.js";
import { createOrcaMcpServer } from "./mcp-server.js";
import { killAllOrcaChildren } from "./orca.js";

// The companion Orca plugin pushes agent states here; without it (or with ORCA_MCP_BRIDGE=0) the tools poll.
const bridge = process.env.ORCA_MCP_BRIDGE === "0" ? undefined : new StatusBridge();
if (bridge) {
  const started = await bridge.start();
  if ("error" in started) console.error(`orca-mcp: status bridge off, polling instead: ${started.error}`);
}

const server = createOrcaMcpServer(bridge ? { bridge } : {});
await server.connect(new StdioServerTransport());

// The client ends this server by closing stdin or with a signal; orca calls still in
// flight lead their own process groups and would outlive it.
const exit = () => {
  bridge?.stop();
  killAllOrcaChildren();
  process.exit(0);
};
process.stdin.on("close", exit);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, exit);
