import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, SERVER_INSTRUCTIONS } from "../../src/register-tools.js";
import { requestConfig } from "../../src/icount-client.js";
import pkg from "../../package.json" with { type: "json" };

const ROUTE = "/mcp";
const TOKEN_HEADER = "x-icount-api-token";
const TIMEOUT_HEADER = "x-icount-timeout-ms";

// A fresh McpServer per request — this Worker is stateless and multi-tenant
// (every caller brings their own iCount token via a header), so nothing here
// may be shared across requests.
async function factory() {
  const server = new McpServer(
    { name: "icount-mcp", version: pkg.version },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerTools(server);
  return server;
}

const mcpHandler = createMcpHandler(factory, { route: ROUTE });

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== ROUTE) {
      return jsonResponse(
        { message: "icount-mcp is running. Send MCP requests to POST /mcp." },
        200
      );
    }

    const token = request.headers.get(TOKEN_HEADER)?.trim();
    if (!token) {
      return jsonResponse(
        { error: `Missing ${TOKEN_HEADER} header. Pass your iCount API token in this header.` },
        401
      );
    }

    const timeoutMs = request.headers.get(TIMEOUT_HEADER) ?? undefined;
    return requestConfig.run({ token, timeoutMs }, () => mcpHandler(request, env, ctx));
  },
};
