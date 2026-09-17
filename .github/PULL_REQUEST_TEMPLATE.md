## What this changes

<!-- One or two sentences. Link the issue it closes, if there is one. -->

## How it was verified

<!-- `npm test` is offline and proves nothing about the live API. If you changed a
     request shape or endpoint, say how you checked it against a real account. -->

- [ ] `npm test` passes
- [ ] Verified against a live iCount account, using non-fiscal doctypes (`order` / `offer`) where possible

## Checklist

- [ ] No API token, account id, or real customer data anywhere in the diff, tests, or fixtures
- [ ] New or changed tools carry the right MCP annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint`)
- [ ] Anything irreversible is documented as such in README.md and SECURITY.md
- [ ] `package.json` `files` still lists only what should be published
- [ ] README updated if a tool, option, or environment variable changed
