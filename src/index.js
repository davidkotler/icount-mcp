#!/usr/bin/env node
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, SERVER_INSTRUCTIONS } from "./register-tools.js";

// Load .env from this package's own directory first (the git-clone install),
// then from the caller's cwd, so the server works the same whether launched via
// `npm start`, `npx icount-mcp`, MCP Inspector, or registered in another tool's
// config with an arbitrary working directory. Neither file is required: dotenv
// ignores a missing path, and it never overrides variables already in the
// environment, so an `env` block in the MCP client config always wins.
//
// `quiet` is mandatory, not cosmetic: stdout is the JSON-RPC channel here, and
// dotenv's "injecting env" banner would corrupt the very first frame.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env"), quiet: true });
config({ quiet: true });

const { version: VERSION } = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
);

const server = new McpServer(
  { name: "icount-mcp", version: VERSION },
  { instructions: SERVER_INSTRUCTIONS }
);

registerTools(server);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Nothing may ever be written to stdout except JSON-RPC frames, so all
// diagnostics go to stderr.
function fatal(label, err) {
  process.stderr.write(`[icount-mcp] ${label}: ${err?.stack || err}\n`);
  process.exit(1);
}

process.on("uncaughtException", (err) => fatal("uncaught exception", err));
process.on("unhandledRejection", (err) => fatal("unhandled rejection", err));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await server.close();
  } catch {
    // Nothing useful to do if the transport is already gone.
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await server.connect(new StdioServerTransport());
} catch (err) {
  fatal("failed to start", err);
}
