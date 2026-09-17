// Unit tests for the iCount HTTP wrapper. `fetch` is stubbed throughout — no
// request ever leaves the machine.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as icount from "../src/icount-client.js";

const realFetch = globalThis.fetch;
const realToken = process.env.ICOUNT_API_TOKEN;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realToken === undefined) delete process.env.ICOUNT_API_TOKEN;
  else process.env.ICOUNT_API_TOKEN = realToken;
  delete process.env.ICOUNT_TIMEOUT_MS;
});

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("sends the token as a bearer header to the pinned iCount host", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-secret";
  const calls = stubFetch(() => jsonResponse({ status: true, ok: 1 }));

  await icount.testConnection();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.icount.co.il/api/v3.php/app/info");
  assert.equal(calls[0].init.headers.Authorization, "Bearer API3E8-secret");
  assert.ok(calls[0].init.signal, "requests must carry an abort signal");
});

test("a whitespace-only token is treated as missing", async () => {
  process.env.ICOUNT_API_TOKEN = "   ";
  stubFetch(() => jsonResponse({ status: true }));
  await assert.rejects(() => icount.testConnection(), /ICOUNT_API_TOKEN is not set/);
});

test("the token is never echoed back in an error message", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-secret";
  stubFetch(() =>
    jsonResponse({ status: false, reason: "bad token: API3E8-secret" }, { status: 401 })
  );

  await assert.rejects(
    () => icount.testConnection(),
    (err) => {
      assert.ok(!err.message.includes("API3E8-secret"), "token leaked into the error message");
      assert.match(err.message, /REDACTED_TOKEN/);
      assert.equal(err.status, 401);
      return true;
    }
  );
});

test("redaction never corrupts a successful response body", async () => {
  // Regression: redacting a short token as a plain substring shredded every
  // response that happened to contain those characters. Redaction belongs on
  // error messages only, and short values are not treated as secrets at all.
  process.env.ICOUNT_API_TOKEN = "t";
  stubFetch(() => jsonResponse({ status: true, data: { client_name: "Test Ltd" } }));

  const data = await icount.testConnection();
  assert.deepEqual(data, { status: true, data: { client_name: "Test Ltd" } });
});

test("an empty search result is not an error", async () => {
  // Regression: iCount answers "nothing matched" with status:false /
  // no_results_found. Treating that as a failure told the agent the server was
  // broken every time a legitimate search came up empty.
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  stubFetch(() => jsonResponse({ status: false, reason: "no_results_found" }));

  const result = await icount.searchDocuments({ doctype: "offer" });
  assert.deepEqual(result, { docs: [], matched: 0 });
});

test("an unfiltered search fails locally, without a round trip", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  const calls = stubFetch(() => jsonResponse({ status: true }));

  await assert.rejects(() => icount.searchDocuments({}), /at least one filter/);
  assert.equal(calls.length, 0, "must not call the API with an empty query");
});

test("opaque reason codes carry actionable guidance", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  stubFetch(() => jsonResponse({ status: false, reason: "too_many_results" }));

  await assert.rejects(
    () => icount.searchDocuments({ startDate: "2020-01-01" }),
    /Narrow the date range/
  );
});

test("open docs requires a client identifier", async () => {
  // Regression: this used to be documented as "omit clientId for all clients",
  // but the live API answers `client_not_found`.
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  const calls = stubFetch(() => jsonResponse({ status: true }));

  await assert.rejects(() => icount.getClientOpenDocs({}), /needs a client/);
  assert.equal(calls.length, 0);

  await icount.getClientOpenDocs({ clientId: "42" });
  assert.equal(calls.length, 1, "a clientId must still go through");
});

test("an HTTP 200 with status:false is still an error", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  stubFetch(() => jsonResponse({ status: false, error_description: "יצירת המסמך נכשלה" }));
  await assert.rejects(() => icount.testConnection(), /יצירת המסמך נכשלה/);
});

test("a non-JSON response produces a readable error", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  stubFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
  await assert.rejects(() => icount.testConnection(), /non-JSON response \(HTTP 502\)/);
});

test("a timeout surfaces as a timeout, not a hang", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  process.env.ICOUNT_TIMEOUT_MS = "1000";
  stubFetch(() => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    throw err;
  });
  await assert.rejects(() => icount.testConnection(), /timed out after 1000ms/);
});

test("an oversized response is refused rather than buffered", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  stubFetch(() =>
    jsonResponse({ status: true }, { headers: { "content-length": String(50 * 1024 * 1024) } })
  );
  await assert.rejects(() => icount.testConnection(), /too large/);
});

test("empty and falsy values are handled correctly in request bodies", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  const calls = stubFetch(() => jsonResponse({ status: true }));

  await icount.cancelDocument({ doctype: "offer", docnum: 5, refundCc: false, reason: "" });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.refund_cc, 0, "0 must survive cleaning");
  assert.ok(!("reason" in body), "empty strings must be dropped");
});

test("clientId takes precedence over clientName on document creation", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  const calls = stubFetch(() => jsonResponse({ status: true }));

  await icount.createDocument({
    doctype: "offer",
    clientId: "42",
    clientName: "Ignored Co",
    items: [{ description: "x", quantity: 1, unitprice: 1 }],
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.client_id, "42");
  assert.ok(!("client_name" in body), "client_name must not shadow an explicit client_id");
});

test("listClients bounds its output and reports truncation", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  const many = Object.fromEntries(
    Array.from({ length: 250 }, (_, i) => [String(i), { client_id: String(i) }])
  );
  stubFetch(() => jsonResponse({ status: true, data: many }));

  const byDefault = await icount.listClients();
  assert.equal(byDefault.total, 250);
  assert.equal(byDefault.returned, 100, "must be bounded by default");
  assert.equal(byDefault.clients.length, 100);

  const limited = await icount.listClients({ maxResults: 5 });
  assert.equal(limited.clients.length, 5);
});

test("cash payments are shaped the way iCount expects", async () => {
  process.env.ICOUNT_API_TOKEN = "API3E8-AAAA-BBBB-CCCC";
  const calls = stubFetch(() => jsonResponse({ status: true }));

  await icount.createDocument({
    doctype: "receipt",
    clientName: "Acme",
    items: [{ description: "Service", quantity: 1, unitprice: 100 }],
    payment: { method: "cash", sum: 100 },
  });

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.cash, { sum: "100" });
});
