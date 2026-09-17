# Contributing

Thanks for looking at `icount-mcp`. It is a small, deliberately narrow server, and the bar for
changes is set by one thing: **it acts on real financial records in someone's accounting account.**
A bug here is not a broken render, it is a wrong invoice.

## Ground rules

- **Never commit a token.** `.env` is gitignored; keep it that way. If you leak one, rotate it in
  iCount under *Personal area → Settings → API* immediately.
- **Never paste real client or document data** into an issue, PR, test fixture, or commit message.
- **Security issues do not go in public issues.** Open a
  [private advisory](https://github.com/davidkotler/icount-mcp/security/advisories/new) instead. See
  [SECURITY.md](SECURITY.md).

## Getting set up

```bash
git clone https://github.com/<you>/icount-mcp.git
cd icount-mcp
npm install
npm test          # offline: no iCount account and no network needed
```

`npm test` mocks the API end to end. It will happily pass while the real endpoint rejects you, so it
proves the server's own logic, nothing about iCount.

## Verifying against a live account

If your change touches a request shape, an endpoint path, or a response parse, the offline tests are
not enough — check it against a real account and say so in the PR.

Do it safely:

- Prefer the **`order` and `offer`** doctypes. They are not fiscal documents and need no `payment`
  object.
- `invoice`, `invrec`, `receipt`, and `refund` are **real tax documents**. iCount has no hard delete
  for any document — the best you can do afterwards is cancel it, and the cancelled record stays in
  the account forever.
- `icount_delete_client` is a genuine, irreversible delete. Only ever point it at a client you
  created yourself for the test.
- Some doctypes may return `אין לך הרשאה` ("no permission") depending on the account's plan and the
  token's permissions. That is an account limitation, not a bug in the server.

## What a good change looks like

- **One concern per PR.** A new tool and a refactor of the request layer are two PRs.
- **Match the surrounding code.** No new dependencies without a reason in the PR description; the
  dependency list is short on purpose, because everything in it runs next to an API token.
- **Every tool carries MCP annotations.** `readOnlyHint` for reads, `destructiveHint` for anything
  irreversible, `idempotentHint` where it applies. Clients use these to decide when to prompt the
  user, so getting one wrong silently removes a confirmation step.
- **Anything irreversible gets documented** in both README.md and the table in SECURITY.md.
- **stdout stays reserved for JSON-RPC.** Diagnostics go to stderr. A stray `console.log` corrupts
  the protocol stream.
- **Keep LF line endings.** `.gitattributes` enforces this; a CRLF shebang in `src/index.js` breaks
  `npx icount-mcp` on macOS and Linux, and CI checks for it.
- **Watch `package.json`'s `files` list** if you add anything at the repo root. Only what is listed
  there is published to npm.

## Submitting

1. Fork, and branch off `main`.
2. Push to your fork and open a PR against `main`. Direct pushes to `main` are blocked.
3. CI runs on every PR (Node 18/20/22 × Linux/macOS/Windows, plus packaging checks) and must be
   green before merge.
4. A first-time contributor's workflow run needs maintainer approval before it starts. That is
   deliberate, not a stall — it stops a fork PR from running arbitrary code in CI.

By contributing you agree your work is licensed under the [MIT License](LICENSE).

## Repository settings (maintainers)

Branch rules for `main` live in [`.github/rulesets/main.json`](.github/rulesets/main.json) so they
are reviewable rather than buried in the web UI. Apply or update them with:

```bash
gh api -X POST repos/davidkotler/icount-mcp/rulesets --input .github/rulesets/main.json
```

Re-applying creates a second ruleset — to change the existing one, `PUT` to
`repos/davidkotler/icount-mcp/rulesets/<id>` instead.

Two settings have no file form and must be toggled under **Settings → Code security**. Both are
free on public repositories, and both are required for the
[Skills IL verification checklist](https://agentskills.co.il/he/guides/github-verification-checklist):

- **Secret scanning** *and* **push protection**. The checklist also requires zero open alerts.
- **CodeQL default setup.** Deliberately *not* checked in as a workflow — enabling default setup
  conflicts with a committed `codeql.yml` advanced-setup workflow, and the checklist asks for
  default setup specifically.

## Releasing (maintainers)

`.github/workflows/release.yml` fires on any `v*` tag and does everything: runs the tests, refuses
a tag that disagrees with `package.json`, builds the tarball once, attests it with
[`actions/attest-build-provenance`](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations),
creates the GitHub release, and publishes that same tarball to npm with `--provenance`.

```bash
npm version patch          # bumps package.json and creates the vX.Y.Z tag
git push --follow-tags
```

npm publishing is skipped with a notice if the `NPM_TOKEN` repository secret is absent; the GitHub
release and its attestation still happen. Verify a published artifact with:

```bash
gh attestation verify icount-mcp-<version>.tgz -R davidkotler/icount-mcp
```

Re-tagging a released version will not work — the tag ruleset blocks moving and deleting `v*` tags.
Cut a new patch version instead.
