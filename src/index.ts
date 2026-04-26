#!/usr/bin/env node
// Backward-compatible MCP entry. New users should use cli.js (with subcommands).
import { runMcpServer } from "./mcp.js";

runMcpServer().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
