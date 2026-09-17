#!/usr/bin/env node
import { config } from "dotenv";
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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "..", ".env") });
config();

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

const PAYMENT_SCHEMA = z
  .object({
    method: z.enum(["cash", "creditcard", "cheque", "banktransfer"]).describe("Payment method"),
    sum: z.number().describe("Amount paid via this method"),
    date: z.string().optional().describe("Payment date, YYYY-MM-DD (defaults to today)"),
    // Credit card
    numOfPayments: z.number().optional(),
    firstPayment: z.string().optional(),
    cardType: z.string().optional().describe("e.g. VISA, MASTERCARD"),
    cardNumber: z.string().optional().describe("Last 4 digits"),
    expYear: z.number().optional(),
    expMonth: z.number().optional(),
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

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "icount-mcp",
  version: "0.2.0",
});

// ---------------------------------------------------------------------------
// App / connection
// ---------------------------------------------------------------------------

server.tool(
  "icount_test_connection",
  "Verify the configured iCount API token works by fetching basic app/account info.",
  {},
  async () => textResult(await icount.testConnection())
);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

server.tool(
  "icount_create_document",
  "Create a document (invoice, receipt, order, offer, etc.) in iCount. " +
    "Prefer non-tax types (order/offer) for testing since iCount has no hard delete, only cancel. " +
    "Real tax documents (receipt/invrec) require a `payment` breakdown or iCount will reject them.",
  {
    doctype: z.enum(DOCTYPES).describe("iCount document type"),
    clientName: z.string().optional().describe("Client name (used when clientId is not given)"),
    clientId: z.string().optional().describe("Existing iCount client id — reuses that client instead of creating/matching by name"),
    clientEmail: z.string().email().optional(),
    clientVatId: z.string().optional().describe("Client VAT/ID number (ח.פ / ע.מ)"),
    clientAddress: z.string().optional(),
    clientCity: z.string().optional(),
    clientPhone: z.string().optional(),
    items: z
      .array(
        z.object({
          description: z.string(),
          quantity: z.number(),
          unitprice: z.number(),
        })
      )
      .min(1)
      .describe("Line items for the document"),
    comments: z.string().optional().describe("Free-text note printed on the document"),
    currency: z.string().optional().describe("Currency code, e.g. ILS, USD (default ILS)"),
    lang: z.enum(["he", "en"]).optional().describe("Document language (default he)"),
    issueDate: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
    dueDate: z.string().optional().describe("YYYY-MM-DD"),
    sendEmail: z.boolean().optional().describe("Email the document to the client after creation"),
    payment: PAYMENT_SCHEMA.optional(),
  },
  async (params) => textResult(await icount.createDocument(params))
);

server.tool(
  "icount_search_documents",
  "Search existing iCount documents by type, status, client, date range, or document number.",
  {
    doctype: z.enum(DOCTYPES).optional(),
    status: z
      .union([z.literal(0), z.literal(1), z.literal(2)])
      .optional()
      .describe("0=open, 1=closed, 2=partially closed"),
    clientId: z.string().optional(),
    clientName: z.string().optional(),
    clientEmail: z.string().optional(),
    vatId: z.string().optional(),
    docnum: z.number().optional(),
    startDate: z.string().optional().describe("YYYY-MM-DD"),
    endDate: z.string().optional().describe("YYYY-MM-DD"),
    sortField: z.enum(["dateissued", "timeissued", "docnum", "paydate", "client_name"]).optional(),
    sortOrder: z.enum(["ASC", "DESC"]).optional(),
    offset: z.number().optional().describe("Pagination offset"),
    maxResults: z.number().min(0).max(1000).optional(),
    detailLevel: z.number().min(0).max(10).optional().describe("0=basic ... 10=complete (default 1)"),
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

server.tool(
  "icount_get_document",
  "Fetch full details of a single existing document by type and number.",
  {
    doctype: z.enum(DOCTYPES),
    docnum: z.union([z.string(), z.number()]),
    getItems: z.boolean().optional().describe("Include line items (default true)"),
    getPayments: z.boolean().optional().describe("Include payment breakdown (default true)"),
    getPdfLink: z.boolean().optional().describe("Include a direct PDF link (default false)"),
  },
  async (params) => textResult(await icount.getDocument(params))
);

server.tool(
  "icount_cancel_document",
  "Cancel an existing document (iCount has no hard delete — this is the only way to void one). " +
    "Irreversible.",
  {
    doctype: z.enum(DOCTYPES),
    docnum: z.union([z.string(), z.number()]),
    refundCc: z.boolean().optional().describe("Also reverse the credit-card charge, if any (fails if there wasn't one)"),
    reason: z.string().optional().describe("Cancellation reason, stored on the record"),
  },
  async (params) => textResult(await icount.cancelDocument(params))
);

server.tool(
  "icount_close_document",
  "Mark a document as closed/paid, optionally linking it to base documents it settles.",
  {
    doctype: z.enum(DOCTYPES),
    docnum: z.union([z.string(), z.number()]),
    basedOn: z
      .array(z.object({ doctype: z.string(), docnum: z.union([z.string(), z.number()]) }))
      .optional()
      .describe("Base documents this closure settles, e.g. an offer this order fulfills"),
  },
  async (params) => textResult(await icount.closeDocument(params))
);

server.tool(
  "icount_convert_document",
  "Convert a document to another type (e.g. offer -> order). Omit conversionType to first list the " +
    "valid conversion options for this document; pass one of those values back in conversionType to " +
    "perform the actual conversion.",
  {
    doctype: z.enum(DOCTYPES),
    docnum: z.union([z.string(), z.number()]),
    conversionType: z
      .string()
      .optional()
      .describe("A value returned by a prior call to this tool without conversionType"),
  },
  async ({ doctype, docnum, conversionType }) =>
    textResult(
      conversionType
        ? await icount.convertDocument({ doctype, docnum, conversionType })
        : await icount.getDocumentConversionOptions({ doctype, docnum })
    )
);

server.tool(
  "icount_get_document_url",
  "Get a viewable/printable URL (PDF) for an existing document.",
  {
    doctype: z.enum(DOCTYPES),
    docnum: z.union([z.string(), z.number()]),
    lang: z.enum(["he", "en"]).optional().describe("UI language for the request (default he)"),
    original: z.boolean().optional().describe("Original vs. copy watermark (default true = original)"),
    hideIls: z.boolean().optional().describe("Hide ILS-equivalent prices (foreign-currency docs only)"),
    docLang: z.enum(["he", "en"]).optional().describe("Language the document itself is rendered in"),
    emailTo: z.string().email().optional().describe("Log this address against the generated link, for tracking"),
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
  paymentTerms: z.number().optional().describe("Payment terms in days"),
};

server.tool(
  "icount_create_client",
  "Create a new client/recipient record directly, without also creating a document.",
  { name: z.string().describe("Client name"), ...CLIENT_FIELDS },
  async (params) => textResult(await icount.createClient(params))
);

server.tool(
  "icount_update_client",
  "Update fields on an existing client. Only fields provided are changed.",
  { clientId: z.string(), name: z.string().optional(), ...CLIENT_FIELDS },
  async (params) => textResult(await icount.updateClient(params))
);

server.tool(
  "icount_get_client",
  "Fetch full details of a single client by id.",
  { clientId: z.string() },
  async (params) => textResult(await icount.getClient(params))
);

server.tool(
  "icount_list_clients",
  "List clients in the account.",
  { maxResults: z.number().optional().describe("Truncate to this many results (default: all)") },
  async (params) => textResult(await icount.listClients(params))
);

server.tool(
  "icount_delete_client",
  "Permanently delete a client record. Unlike documents, this is a real, irreversible delete — " +
    "prefer this only for clients with no associated documents.",
  { clientId: z.string() },
  async (params) => textResult(await icount.deleteClient(params))
);

server.tool(
  "icount_get_client_open_docs",
  "List a client's open (unpaid/unsettled) documents — their outstanding balance. Omit clientId to " +
    "get open documents across all clients.",
  {
    clientId: z.string().optional(),
    doctype: z.enum(DOCTYPES).optional(),
    getItems: z.boolean().optional().describe("Include line items on each document"),
    email: z.string().optional().describe("Filter by client email instead of id"),
    clientName: z.string().optional().describe("Filter by client name instead of id"),
  },
  async (params) => textResult(await icount.getClientOpenDocs(params))
);

const transport = new StdioServerTransport();
await server.connect(transport);
