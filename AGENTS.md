# Pictureline Cash Reports (true-cogs)

This app connects read-only to Pictureline's production QuickBooks Online company and produces cash-verified financial reports (accounting-basis P&L, bank reconciliation, cash flow, inventory/COGS) at https://web-production-8c8c0.up.railway.app.

**The owner, Chris, is non-technical:** give exact paste-ready commands with expected output, and make the app explain its own errors in plain language — never surface raw API errors (they once leaked a token).

**Before starting any task:** read `INDEX.md`, `entities/project-status.md`, and `entities/roadmap.md` from the `chrisbachmaxwell/true-cogs-brain` repo, then follow the INDEX links relevant to your task. Ground claims in vault pages; when reality contradicts a brain page, fix that page in the same session; write a dated note in the brain's `log/` at session end.

## Build & verify (must pass before ANY push)

```bash
npm run build && npm test
```

Both must succeed — `tsc` clean and all unit tests (28 as of 2026-07-15) passing. Deploy is `railway up --detach`; verify deploys via a static-asset marker, never by polling a computing endpoint (see the brain's `concepts/deploy-race-stale-recompute.md`).
