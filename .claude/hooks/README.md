# HisabKitab commit guard (PreToolUse hook)

`guard-commit.sh` runs before every Bash tool call. For `git commit` / `git push`
it inspects the **staged diff** and blocks the call (PreToolUse `deny`) when it
would record a CLAUDE.md violation:

| Class | What it catches | Rule |
|---|---|---|
| Secrets | a real `.env`, an `sk-ant-…` key, or a real value assigned to `KHALTI_SECRET_KEY` / `WA_ACCESS_TOKEN` / `TENANT_SIGNING_SECRET` / `LEDGER_MCP_TOKEN` / `PAYMENTS_MCP_TOKEN` | §4 — `.env.example` only; secrets live in vaults / `manual.txt` |
| Float money | `parseFloat`/`Number(...)` on a paisa/amount/vat/tds/total field | §3 — money is integer paisa (bigint), never floats |
| Raw SQL | an interpolated `SELECT/INSERT/UPDATE/DELETE` template literal outside `packages/db/` | §3 — no raw SQL exposed to the model; use parameterized tenant-scoped tools |

Placeholders (`CHANGE_ME`, `example`, `<…>`, `test_`, `stub`) are intentionally
**not** blocked, so `.env.example` and fixtures pass. Non-git commands pass through
untouched. The decision travels in the hook's JSON, not the exit code.

Wired in `.claude/settings.json` (committed → team-wide). Review/disable via `/hooks`.
After pulling this for the first time, open `/hooks` once (or restart) so Claude
Code loads the new settings file.
