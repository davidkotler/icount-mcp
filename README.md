# icount-mcp

An [MCP](https://modelcontextprotocol.io) server for [iCount](https://www.icount.co.il) — Israeli cloud
accounting/invoicing software. Lets any MCP-compatible AI agent (Claude Code, Claude Desktop, Cursor,
Windsurf, n8n, etc.) create and manage iCount documents (invoices, receipts, orders, offers...) and
clients directly from a conversation.

Runs as a local **stdio** server — no hosting, no OAuth flow, just a static API token.

> Unofficial, community-built integration. Not affiliated with or endorsed by iCount. You are
> responsible for the documents and data this creates in your own iCount account.

## Requirements

- Node.js 18+
- An iCount account with an **API Token** (not your login user/pass — see below)

## Getting your API token

1. Log in to your iCount account.
2. Go to **אזור אישי → הגדרות → API** (Personal area → Settings → API).
3. Create a new API Token.
4. Copy it — you'll need it below. It looks like `API3E8-XXXXXXXX-XXXXXXXX-XXXXXXXXXXXXXXXX`.

This is iCount API v3, which authenticates with a single static Bearer token — unlike the legacy
`create_doc.php` API, which used `cid`/`user`/`pass`. Only the token works with this server.

## Install

Nothing to clone or install — `npx` fetches and runs it on demand. Just add it to your MCP client
config with your token:

```json
{
  "mcpServers": {
    "icount": {
      "command": "npx",
      "args": ["-y", "icount-mcp"],
      "env": {
        "ICOUNT_API_TOKEN": "API3E8-XXXXXXXX-XXXXXXXX-XXXXXXXXXXXXXXXX"
      }
    }
  }
}
```

That file is `.mcp.json` in your project (Claude Code), `claude_desktop_config.json` (Claude Desktop),
`~/.cursor/mcp.json` (Cursor), or the equivalent for your client. On Windows, some clients need
`"command": "npx.cmd"`.

### Claude Code

```bash
claude mcp add icount --env ICOUNT_API_TOKEN=API3E8-... -- npx -y icount-mcp
```

### Pin a version

`npx -y icount-mcp` always runs the latest published version. To pin:

```json
{ "command": "npx", "args": ["-y", "icount-mcp@0.2.0"] }
```

Or install it once, globally, and skip the npx download entirely:

```bash
npm install -g icount-mcp
```

```json
{ "command": "icount-mcp", "env": { "ICOUNT_API_TOKEN": "API3E8-..." } }
```

### From source (development)

```bash
git clone https://github.com/davidkotler/icount-mcp.git
cd icount-mcp
npm install
cp .env.example .env    # then paste your token into it
```

```json
{ "command": "node", "args": ["/absolute/path/to/icount-mcp/src/index.js"] }
```

The token can come from either the `env` block or a `.env` file — the `env` block wins when both are
set. A `.env` is looked for next to the package and in the working directory; with `npx` you'll want
the `env` block.

### Verify it's working

Ask your agent to "test the icount connection" — it should call `icount_test_connection` and get back
basic account/API info.

## Tools

### Documents

| Tool | What it does |
|---|---|
| `icount_test_connection` | Verify the token works |
| `icount_create_document` | Create an invoice, receipt, order, offer, etc. |
| `icount_search_documents` | Search documents by type, status, client, date range |
| `icount_get_document` | Fetch full details of one document |
| `icount_cancel_document` | Cancel a document (irreversible — iCount has no hard delete) |
| `icount_close_document` | Mark a document closed/paid |
| `icount_convert_document` | Convert a document to another type (e.g. offer → order) |
| `icount_get_document_url` | Get a printable/viewable PDF URL |

### Clients

| Tool | What it does |
|---|---|
| `icount_create_client` | Create a client record directly (no document) |
| `icount_update_client` | Update an existing client's fields |
| `icount_get_client` | Fetch a client's details |
| `icount_list_clients` | List clients in the account |
| `icount_delete_client` | **Really** delete a client (unlike documents, this has no cancel-only restriction) |
| `icount_get_client_open_docs` | A client's outstanding/unpaid documents |

Document types (`doctype`): `invoice`, `invrec` (חשבונית מס-קבלה), `receipt`, `refund`, `order`, `offer`,
`delivery`, `deal`.

## ⚠️ Important: real tax documents need a payment breakdown

`invoice`, `invrec`, `receipt`, and `refund` are real fiscal documents. Creating them **without** a
`payment` object will fail with an opaque `"יצירת המסמך נכשלה"` ("document creation failed") error —
even though the *client* record may already have been created as a side effect before validation failed.

```json
{
  "doctype": "receipt",
  "clientName": "Some Client",
  "items": [{ "description": "Service", "quantity": 1, "unitprice": 100 }],
  "payment": { "method": "cash", "sum": 100 }
}
```

`payment.method` is one of `cash`, `creditcard`, `cheque`, `banktransfer`. For testing purposes, prefer
`order` or `offer` doctypes instead — they're non-tax documents with no payment requirement, and (like
all iCount documents) can't be hard-deleted, only cancelled.

## Development notes / how this was verified

iCount's public documentation (`apiv3.icount.co.il/docs/iCount/`) is a JS-rendered Postman page that
isn't easy to scrape. The endpoint map used here (`/api/v3.php/<module>/<method>`) was cross-checked
against the open-source [n8n-nodes-icount](https://github.com/binesamit/n8n-nodes-icount) node (MIT
licensed) and then **empirically verified against a live iCount account**: every tool in this server was
exercised end-to-end (including a full create → update → delete client lifecycle, and a real receipt
creation + cancellation) before being shipped.

## Roadmap / not yet implemented

- Client contacts (`client/get_contacts`, `add_contact`, `update_contact`, `delete_contact`)
- Client upsert-by-VAT/email (`client/find` + `client/create_or_update`)
- `doc/update_doc_income_type`, `doc/list` (superseded here by the more flexible `doc/search`)
- Expenses, suppliers, inventory, CRM, and time-tracking modules (separate iCount API areas entirely)

## License

MIT
