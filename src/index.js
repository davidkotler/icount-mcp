#!/usr/bin/env node
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as icount from "./icount-client.js";

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

// Non-tax document types (offer, order, delivery, deal) are safe to create
// repeatedly while testing since they don't carry the same audit/cancellation
// requirements as invoice/invrec/receipt/refund. Verified against the live
// iCount v3 API (see README for the endpoint-discovery notes).
const DOCTYPES = [
  "invoice",
  "invrec",
  "receipt",
  "refund",
  "order",
  "offer",
  "delivery",
  "deal",
];

const isoDate = (what) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be an ISO date, YYYY-MM-DD")
    .describe(what);

const docnumSchema = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe("The document number as shown in iCount");

const PAYMENT_SCHEMA = z
  .object({
    method: z.enum(["cash", "creditcard", "cheque", "banktransfer"]).describe("Payment method"),
    sum: z.number().describe("Amount paid via this method"),
    date: isoDate("Payment date (defaults to today)").optional(),
    // Credit card
    numOfPayments: z.number().int().positive().optional(),
    firstPayment: z.string().optional(),
    cardType: z.string().optional().describe("e.g. VISA, MASTERCARD"),
    cardNumber: z.string().optional().describe("Last 4 digits only — never send a full PAN"),
    expYear: z.number().int().optional(),
    expMonth: z.number().int().min(1).max(12).optional(),
    holderId: z.string().optional(),
    holderName: z.string().optional(),
    confirmationCode: z.string().optional(),
    // Cheque
    bank: z.string().optional(),
    branch: z.string().optional(),
    account: z.string().optional(),
    chequeNumber: z.string().optional(),
  })
  .describe(
    "Required for real tax documents (receipt/invrec) — iCount rejects those doctypes " +
      "without an actual payment breakdown. Not needed for order/offer/delivery/deal."
  );

// Guard against a single tool call flooding the agent's context with a huge
// iCount payload. The cap is generous; hitting it means the query was too broad.
const MAX_RESULT_CHARS = 200_000;

function textResult(data) {
  let text = JSON.stringify(data, null, 2);
  if (text.length > MAX_RESULT_CHARS) {
    text =
      text.slice(0, MAX_RESULT_CHARS) +
      `\n\n[truncated — response exceeded ${MAX_RESULT_CHARS} characters. ` +
      `Narrow the query with filters, maxResults, or a lower detailLevel.]`;
  }
  return { content: [{ type: "text", text }] };
}

const server = new McpServer(
  { name: "icount-mcp", version: VERSION },
  {
    instructions:
      "Tools for the iCount accounting API. These act on real financial records in a live " +
      "account.\n\n" +
      "- `invoice`, `invrec`, `receipt` and `refund` are fiscal documents. They require a " +
      "`payment` breakdown or iCount rejects them, and they can never be deleted — only " +
      "cancelled. Confirm with the user before creating one.\n" +
      "- `order`, `offer`, `delivery` and `deal` are non-fiscal and safe for drafts and testing.\n" +
      "- `icount_cancel_document` and `icount_delete_client` are irreversible. Always confirm " +
      "with the user first, and prefer looking the record up by number before acting on it.\n" +
      "- Call `icount_test_connection` first if the token's validity is in doubt.",
  }
);

// Shared annotation presets. `openWorldHint` is true everywhere because every
// tool reaches a live external API.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

// ---------------------------------------------------------------------------
// App / connection
// ---------------------------------------------------------------------------

server.registerTool(
  "icount_test_connection",
  {
    title: "Test iCount connection",
    description: "Verify the configured iCount API token works by fetching basic app/account info.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => textResult(await icount.testConnection())
);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

server.registerTool(
  "icount_create_document",
  {
    title: "Create document",
    description:
      "Create a document (invoice, receipt, order, offer, etc.) in iCount. " +
      "Prefer non-tax types (order/offer) for testing since iCount has no hard delete, only cancel. " +
      "Real tax documents (receipt/invrec) require a `payment` breakdown or iCount will reject them.",
    inputSchema: {
      doctype: z.enum(DOCTYPES).describe("iCount document type"),
      clientName: z.string().optional().describe("Client name (used when clientId is not given)"),
      clientId: z
        .string()
        .optional()
        .describe("Existing iCount client id — reuses that client instead of creating/matching by name"),
      clientEmail: z.string().email().optional(),
      clientVatId: z.string().optional().describe("Client VAT/ID number (ח.פ / ע.מ)"),
      clientAddress: z.string().optional(),
      clientCity: z.string().optional(),
      clientPhone: z.string().optional(),
      items: z
        .array(
          z.object({
            description: z.string().min(1),
            quantity: z.number(),
            unitprice: z.number(),
          })
        )
        .min(1)
        .max(500)
        .describe("Line items for the document"),
      comments: z.string().optional().describe("Free-text note printed on the document"),
      currency: z
        .string()
        .regex(/^[A-Za-z]{3}$/, "Must be a 3-letter ISO 4217 code")
        .optional()
        .describe("Currency code, e.g. ILS, USD (default ILS)"),
      lang: z.enum(["he", "en"]).optional().describe("Document language (default he)"),
      issueDate: isoDate("Issue date, defaults to today").optional(),
      dueDate: isoDate("Due date").optional(),
      sendEmail: z.boolean().optional().describe("Email the document to the client after creation"),
      payment: PAYMENT_SCHEMA.optional(),
    },
    annotations: WRITE,
  },
  async (params) => textResult(await icount.createDocument(params))
);

server.registerTool(
  "icount_search_documents",
  {
    title: "Search documents",
    description:
      "Search existing iCount documents by type, status, client, date range, or document number.",
    inputSchema: {
      doctype: z.enum(DOCTYPES).optional(),
      status: z
        .union([z.literal(0), z.literal(1), z.literal(2)])
        .optional()
        .describe("0=open, 1=closed, 2=partially closed"),
      clientId: z.string().optional(),
      clientName: z.string().optional(),
      clientEmail: z.string().optional(),
      vatId: z.string().optional(),
      docnum: z.number().int().positive().optional(),
      startDate: isoDate("Range start").optional(),
      endDate: isoDate("Range end").optional(),
      sortField: z.enum(["dateissued", "timeissued", "docnum", "paydate", "client_name"]).optional(),
      sortOrder: z.enum(["ASC", "DESC"]).optional(),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
      maxResults: z.number().int().min(1).max(1000).optional().describe("Default 100"),
      detailLevel: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("0=basic ... 10=complete (default 1). High values return a lot of data."),
    },
    annotations: READ_ONLY,
  },
  async ({ clientId, clientName, clientEmail, vatId, startDate, endDate, sortField, sortOrder, ...rest }) =>
    textResult(
      await icount.searchDocuments({
        ...rest,
        client_id: clientId,
        client_name: clientName,
        email: clientEmail,
        vat_id: vatId,
        start_date: startDate,
        end_date: endDate,
        sort_field: sortField,
        sort_order: sortOrder,
      })
    )
);

server.registerTool(
  "icount_get_document",
  {
    title: "Get document",
    description: "Fetch full details of a single existing document by type and number.",
    inputSchema: {
      doctype: z.enum(DOCTYPES),
      docnum: docnumSchema,
      getItems: z.boolean().optional().describe("Include line items (default true)"),
      getPayments: z.boolean().optional().describe("Include payment breakdown (default true)"),
      getPdfLink: z.boolean().optional().describe("Include a direct PDF link (default false)"),
    },
    annotations: READ_ONLY,
  },
  async (params) => textResult(await icount.getDocument(params))
);

server.registerTool(
  "icount_cancel_document",
  {
    title: "Cancel document",
    description:
      "Cancel an existing document (iCount has no hard delete — this is the only way to void one). " +
      "Irreversible: confirm the document number with the user before calling.",
    inputSchema: {
      doctype: z.enum(DOCTYPES),
      docnum: docnumSchema,
      refundCc: z
        .boolean()
        .optional()
        .describe("Also reverse the credit-card charge, if any (fails if there wasn't one)"),
      reason: z.string().optional().describe("Cancellation reason, stored on the record"),
    },
    annotations: DESTRUCTIVE,
  },
  async (params) => textResult(await icount.cancelDocument(params))
);

server.registerTool(
  "icount_close_document",
  {
    title: "Close document",
    description: "Mark a document as closed/paid, optionally linking it to base documents it settles.",
    inputSchema: {
      doctype: z.enum(DOCTYPES),
      docnum: docnumSchema,
      basedOn: z
        .array(z.object({ doctype: z.enum(DOCTYPES), docnum: docnumSchema }))
        .optional()
        .describe("Base documents this closure settles, e.g. an offer this order fulfills"),
    },
    annotations: WRITE,
  },
  async (params) => textResult(await icount.closeDocument(params))
);

server.registerTool(
  "icount_convert_document",
  {
    title: "Convert document",
    description:
      "Convert a document to another type (e.g. offer -> order). Omit conversionType to first list the " +
      "valid conversion options for this document; pass one of those values back in conversionType to " +
      "perform the actual conversion.",
    inputSchema: {
      doctype: z.enum(DOCTYPES),
      docnum: docnumSchema,
      conversionType: z
        .string()
        .optional()
        .describe("A value returned by a prior call to this tool without conversionType"),
    },
    annotations: WRITE,
  },
  async ({ doctype, docnum, conversionType }) =>
    textResult(
      conversionType
        ? await icount.convertDocument({ doctype, docnum, conversionType })
        : await icount.getDocumentConversionOptions({ doctype, docnum })
    )
);

server.registerTool(
  "icount_get_document_url",
  {
    title: "Get document PDF URL",
    description: "Get a viewable/printable URL (PDF) for an existing document.",
    inputSchema: {
      doctype: z.enum(DOCTYPES),
      docnum: docnumSchema,
      lang: z.enum(["he", "en"]).optional().describe("UI language for the request (default he)"),
      original: z.boolean().optional().describe("Original vs. copy watermark (default true = original)"),
      hideIls: z.boolean().optional().describe("Hide ILS-equivalent prices (foreign-currency docs only)"),
      docLang: z.enum(["he", "en"]).optional().describe("Language the document itself is rendered in"),
      emailTo: z
        .string()
        .email()
        .optional()
        .describe("Log this address against the generated link, for tracking"),
    },
    annotations: READ_ONLY,
  },
  async (params) => textResult(await icount.getDocumentUrl(params))
);

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const CLIENT_FIELDS = {
  vatId: z.string().optional().describe("VAT/ID number (ח.פ / ע.מ)"),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  notes: z.string().optional(),
  customClientId: z.string().optional().describe("Your own external id for this client"),
  paymentTerms: z.number().int().min(0).optional().describe("Payment terms in days"),
};

server.registerTool(
  "icount_create_client",
  {
    title: "Create client",
    description: "Create a new client/recipient record directly, without also creating a document.",
    inputSchema: { name: z.string().min(1).describe("Client name"), ...CLIENT_FIELDS },
    annotations: WRITE,
  },
  async (params) => textResult(await icount.createClient(params))
);

server.registerTool(
  "icount_update_client",
  {
    title: "Update client",
    description: "Update fields on an existing client. Only fields provided are changed.",
    inputSchema: { clientId: z.string().min(1), name: z.string().min(1).optional(), ...CLIENT_FIELDS },
    annotations: { ...WRITE, idempotentHint: true },
  },
  async (params) => textResult(await icount.updateClient(params))
);

server.registerTool(
  "icount_get_client",
  {
    title: "Get client",
    description: "Fetch full details of a single client by id.",
    inputSchema: { clientId: z.string().min(1) },
    annotations: READ_ONLY,
  },
  async (params) => textResult(await icount.getClient(params))
);

server.registerTool(
  "icount_list_clients",
  {
    title: "List clients",
    description:
      "List clients in the account. Returns `{ total, returned, clients }` so you can tell when the " +
      "list was truncated.",
    inputSchema: {
      maxResults: z.number().int().min(1).max(1000).optional().describe("Default 100"),
      detailLevel: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("0=basic ... 10=complete (default 1). High values return a lot of data."),
    },
    annotations: READ_ONLY,
  },
  async (params) => textResult(await icount.listClients(params))
);

server.registerTool(
  "icount_delete_client",
  {
    title: "Delete client",
    description:
      "Permanently delete a client record. Unlike documents, this is a real, irreversible delete — " +
      "confirm with the user first, and prefer it only for clients with no associated documents.",
    inputSchema: { clientId: z.string().min(1) },
    annotations: DESTRUCTIVE,
  },
  async (params) => textResult(await icount.deleteClient(params))
);

server.registerTool(
  "icount_get_client_open_docs",
  {
    title: "Get client open documents",
    description:
      "List a client's open (unpaid/unsettled) documents — their outstanding balance. Omit clientId to " +
      "get open documents across all clients.",
    inputSchema: {
      clientId: z.string().optional(),
      doctype: z.enum(DOCTYPES).optional(),
      getItems: z.boolean().optional().describe("Include line items on each document"),
      email: z.string().optional().describe("Filter by client email instead of id"),
      clientName: z.string().optional().describe("Filter by client name instead of id"),
    },
    annotations: READ_ONLY,
  },
  async (params) => textResult(await icount.getClientOpenDocs(params))
);

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
