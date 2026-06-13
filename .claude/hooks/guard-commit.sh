#!/usr/bin/env bash
# PreToolUse guard for HisabKitab — runs before any Bash tool call.
#
# This repo handles money and secrets, so two classes of mistake must NEVER reach
# a commit:
#   1. Real secrets (API keys, signing secrets, Khalti/WhatsApp tokens, .env) —
#      CLAUDE.md §4: ".env.example only; never commit real keys."
#   2. Money-safety regressions — floating-point money or raw SQL handed to the
#      model — CLAUDE.md §3: "Money = integer paisa (bigint), never floats" and
#      "No raw SQL exposed to the model."
#
# It inspects the STAGED diff (what `git commit` will actually record) and the
# command itself. Non-git commands pass through untouched. On a hit it emits the
# PreToolUse deny JSON so Claude Code blocks the call and shows the reason.
#
# Output contract (PreToolUse): print JSON with
#   hookSpecificOutput.permissionDecision = "deny" + permissionDecisionReason.
# Exit 0 always (the decision travels in JSON, not the exit code).
set -euo pipefail

# ---- read the hook payload from stdin -------------------------------------
payload="$(cat)"
tool="$(printf '%s' "$payload" | jq -r '.tool_name // empty')"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')"

allow() { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n'; exit 0; }
deny() {
  # $1 = human-readable reason (already escaped-safe via jq)
  jq -cn --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# Only guard git commit / git push. Everything else is allowed untouched.
case "$tool" in
  Bash) ;;
  *) allow ;;
esac
printf '%s' "$cmd" | grep -Eq '\bgit\s+(commit|push)\b' || allow

# What will this commit actually record? Prefer the staged diff; for `git commit
# -a`/`git push` fall back to the full working+staged diff against HEAD.
if printf '%s' "$cmd" | grep -Eq '\bgit\s+commit\b.*(-a|--all)\b'; then
  diff="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" diff HEAD 2>/dev/null || true)"
else
  diff="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" diff --cached 2>/dev/null || true)"
fi
files="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" diff --cached --name-only 2>/dev/null || true)"

# ---- 1. real secrets ------------------------------------------------------
# A committed .env (the real one) — only .env.example is allowed.
if printf '%s' "$files" | grep -Eq '(^|/)\.env$'; then
  deny "Blocked: a real .env is staged. CLAUDE.md §4 — commit .env.example only, never real keys. Unstage it (git restore --staged .env)."
fi

# Concrete secret-value shapes in ADDED lines (the '+' side of the diff). We look
# at added lines only so pre-existing placeholders never trip it.
added="$(printf '%s' "$diff" | grep -E '^\+' || true)"

secret_hit=""
# Anthropic key, Khalti live secret, generic long bearer assigned to a known var.
if printf '%s' "$added" | grep -Eq 'sk-ant-[A-Za-z0-9_-]{20,}'; then secret_hit="an Anthropic API key (sk-ant-…)"; fi
if [ -z "$secret_hit" ] && printf '%s' "$added" | grep -Eiq '(KHALTI_SECRET_KEY|WA_ACCESS_TOKEN|TENANT_SIGNING_SECRET|LEDGER_MCP_TOKEN|PAYMENTS_MCP_TOKEN)\s*[:=]\s*[^\s"'"'"']{12,}'; then
  # allow obvious placeholders (CHANGE_ME / empty / <...> / example)
  if printf '%s' "$added" | grep -Ei '(KHALTI_SECRET_KEY|WA_ACCESS_TOKEN|TENANT_SIGNING_SECRET|LEDGER_MCP_TOKEN|PAYMENTS_MCP_TOKEN)\s*[:=]\s*[^\s"'"'"']{12,}' \
     | grep -Eivq 'CHANGE_ME|example|<[^>]+>|your[-_]|placeholder|test[-_]|verify[-_]|stub'; then
    secret_hit="a real secret value assigned to a credential env var"
  fi
fi
if [ -n "$secret_hit" ]; then
  deny "Blocked: this commit appears to add $secret_hit. CLAUDE.md §4 — secrets live in Managed Agents vaults / the gitignored manual.txt, never the repo. Remove it before committing."
fi

# ---- 2. money-safety regressions -----------------------------------------
# Added TypeScript code that does float money math: parseFloat / Number(...) on a
# *paisa/amount/price/money* identifier, or a decimal literal assigned to one.
money_float="$(printf '%s' "$added" \
  | grep -Ei '(parseFloat|Number)\s*\([^)]*(paisa|amount|price|vat|tds|total|payable)[^)]*\)' \
  | grep -Ev 'amountText|//|\*' || true)"
if [ -n "$money_float" ]; then
  deny "Blocked: this commit adds float math on a money value (parseFloat/Number on a paisa/amount field). CLAUDE.md §3 — money is integer paisa (bigint), never floats. Use bigint paisa + decimal.js."
fi

# Raw SQL string built for / exposed to the model (a tool returning interpolated
# SQL). Heuristic: an added template literal containing SELECT/INSERT/UPDATE/DELETE
# with a ${...} interpolation, OUTSIDE the db/ + migrations layer.
if printf '%s' "$files" | grep -Eqv '^packages/db/'; then
  raw_sql="$(printf '%s' "$added" \
    | grep -Ei '`[^`]*(select|insert|update|delete)\b[^`]*\$\{[^}]+\}[^`]*`' \
    | grep -Ev 'migrations|/db/|test' || true)"
  if [ -n "$raw_sql" ]; then
    deny "Blocked: this commit adds an interpolated raw-SQL string outside packages/db. CLAUDE.md §3 — no raw SQL exposed to the model; use parameterized, tenant-scoped tools (drizzle)."
  fi
fi

allow
