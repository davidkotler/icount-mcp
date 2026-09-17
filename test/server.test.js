// Offline smoke tests: they spawn the real server over stdio and speak JSON-RPC
// to it, but never touch the iCount API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

/** Send `requests` to a fresh server process and collect its stdout/stderr. */
function run(requests, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: cwd ?? process.cwd(),
      env: { ...process.env, ICOUNT_API_TOKEN: "test-token", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, stderr }));

    for (const req of requests) child.stdin.write(JSON.stringify(req) + "\n");
    child.stdin.end();

    const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", () => clearTimeout(kill));
  });
}

function parseFrames(stdout) {
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line)); // throws if anything non-JSON reached stdout
}

test("initialize handshake returns server info", async () => {
  const { stdout } = await run([INIT]);
  const [frame] = parseFrames(stdout);
  assert.equal(frame.jsonrpc, "2.0");
  assert.equal(frame.result.serverInfo.name, "icount-mcp");
  assert.match(frame.result.serverInfo.version, /^\d+\.\d+\.\d+/);
});

test("stdout stays pure JSON-RPC even when a .env is loaded", async () => {
  // dotenv >=16.5 prints an "injecting env" banner unless silenced; on stdout
  // that banner corrupts the first JSON-RPC frame and the handshake fails.
  const dir = mkdtempSync(path.join(tmpdir(), "icount-mcp-test-"));
  writeFileSync(path.join(dir, ".env"), "ICOUNT_SOME_UNUSED_VAR=1\n");
  try {
    const { stdout } = await run([INIT], { cwd: dir });
    assert.doesNotThrow(() => parseFrames(stdout), "stdout must contain only JSON-RPC frames");
    assert.equal(parseFrames(stdout).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every tool is advertised with a description and annotations", async () => {
  const { stdout } = await run([
    INIT,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const listed = parseFrames(stdout).find((f) => f.id === 2);
  const tools = listed.result.tools;

  assert.equal(tools.length, 14, "tool count changed — update the README table too");

  for (const tool of tools) {
    assert.match(tool.name, /^icount_[a-z_]+$/, `${tool.name} breaks the naming convention`);
    assert.ok(tool.description?.length > 20, `${tool.name} needs a real description`);
    assert.ok(tool.inputSchema, `${tool.name} is missing an input schema`);
    assert.ok(tool.annotations, `${tool.name} is missing annotations`);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", `${tool.name}`);
    assert.equal(tool.annotations.openWorldHint, true, `${tool.name} calls a remote API`);
  }
});

test("irreversible tools are flagged destructive", async () => {
  const { stdout } = await run([
    INIT,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const tools = parseFrames(stdout).find((f) => f.id === 2).result.tools;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  for (const name of ["icount_cancel_document", "icount_delete_client"]) {
    assert.equal(byName[name].annotations.destructiveHint, true, `${name} must be destructive`);
    assert.equal(byName[name].annotations.readOnlyHint, false, `${name} must not be read-only`);
  }
  assert.equal(byName.icount_list_clients.annotations.readOnlyHint, true);
  assert.equal(byName.icount_search_documents.annotations.readOnlyHint, true);
});

test("a missing token fails as a tool error, not a crash", async () => {
  const { stdout } = await run(
    [
      INIT,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "icount_test_connection", arguments: {} } },
    ],
    { env: { ICOUNT_API_TOKEN: "" } }
  );
  const res = parseFrames(stdout).find((f) => f.id === 2).result;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /ICOUNT_API_TOKEN is not set/);
});

test("invalid arguments are rejected by the schema before any request", async () => {
  const { stdout } = await run([
    INIT,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "icount_create_document",
        // Bad doctype, bad date format, empty items.
        arguments: { doctype: "not_a_doctype", issueDate: "17/09/2026", items: [] },
      },
    },
  ]);
  const frame = parseFrames(stdout).find((f) => f.id === 2);
  const text = JSON.stringify(frame);
  assert.ok(frame.error || frame.result?.isError, "invalid input must be rejected");
  assert.match(text, /doctype/i);
});
