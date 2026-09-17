# Security

## Reporting a vulnerability

Please report security issues privately via
[GitHub security advisories](https://github.com/davidkotler/icount-mcp/security/advisories/new)
rather than opening a public issue.

## Threat model

`icount-mcp` is a **local stdio server**. It is launched as a child process by your MCP client
(Claude Code, Claude Desktop, Cursor, …), speaks JSON-RPC over stdin/stdout, and listens on no
network port. Anyone who can already run processes as your user can already read your token, so the
boundary this server defends is the one between the *model* and your iCount account — not between
you and your own machine.

### What the server does

- Reads `ICOUNT_API_TOKEN` from the environment (or a `.env` file) and sends it as a bearer token.
- Talks only to `https://api.icount.co.il`. The host is hardcoded and **cannot** be redirected by an
  environment variable, so a poisoned environment cannot turn the server into a token exfiltrator.
- Redacts the token from any error message before it is returned, in case the API echoes request
  context back.
- Times out every request (30s default, `ICOUNT_TIMEOUT_MS` to change, clamped to 1s–300s) so a
  stalled call cannot hang the client.
- Caps response and tool-output size so one broad query cannot flood the agent's context.
- Writes diagnostics to stderr only. stdout carries JSON-RPC frames exclusively.

### What the server does *not* do

- It does not log, cache, or persist your token or any document data.
- It does not add a confirmation step of its own. **The model can call every tool.**

## Tools that change or destroy data

Tool annotations mark which tools write and which are irreversible, and MCP clients use these to
decide when to prompt you:

| Tool | Annotation |
|---|---|
| `icount_cancel_document` | `destructiveHint: true` — iCount has no hard delete; cancelling is permanent |
| `icount_delete_client` | `destructiveHint: true` — a real, irreversible delete |
| `icount_create_document` | write — a fiscal document (`invoice`/`invrec`/`receipt`/`refund`) cannot be deleted afterwards, only cancelled |
| `icount_create_client`, `icount_update_client`, `icount_close_document`, `icount_convert_document` | write |
| everything else | `readOnlyHint: true` |

**Keep tool-approval prompts on for this server.** Do not add it to an auto-approve list. It acts on
real financial records, and a prompt-injected or simply mistaken model can cancel an invoice or
delete a client as easily as it can list them.

## Protecting your token

- Prefer the `env` block in your MCP client config over a `.env` file. Both work; `env` wins when
  both are set.
- An iCount API token grants full access to the account's documents and clients. Treat it like a
  password: never commit it, and rotate it in **Personal area → Settings → API** if it is exposed.
- If you use a `.env` file, note the server also reads one from the current working directory. Do
  not launch it from a directory whose `.env` you do not control.
