# Pictureline — Material Inventory Cash Spend Tracker

A small internal web app that connects to Pictureline's QuickBooks Online company
and answers one question precisely for any given month:

> **How much actual cash and credit-card money left the business for Material
> Inventory purchases that month?**

This is deliberately different from "what got booked to Material Inventory that
month." A bill can be coded $20,000 to Material Inventory but only $18,000
actually leaves the bank/card because $2,000 was covered by a vendor credit
applied at payment time. This app reports the real cash-out number, not the
booked accrual number.

## How the number is computed

"Material Inventory" is an **Account** in the Chart of Accounts. Its `Id` is
looked up once (`SELECT * FROM Account WHERE Name = 'Material Inventory'`) and
cached; all filtering matches `AccountBasedExpenseLineDetail.AccountRef.value`
against it. The monthly total is the sum of two independent buckets
(`src/inventorySpend.ts`):

**Bucket 1 — Bills paid via BillPayment.** All `BillPayment` transactions dated
in the month. Each payment line linked to a Bill is allocated by that bill's
inventory ratio: `(inventory-coded line total ÷ Bill.TotalAmt) × payment line
amount`. The bill's own total is used *only* for this ratio — bills are accrual
records, not cash events. Both `Check` and `CreditCard` pay types count.

Vendor credits need no separate handling: when a credit is applied at payment
time, the payment's bill line is already net of it. A $20,000 bill paid with a
$2,000 credit + $18,000 cash shows up here as $18,000. VendorCredit entities are
**not** subtracted — that would double-count.

**Bucket 2 — Direct Purchases.** All `Purchase` transactions dated in the month,
summing lines coded to the account. `Credit = true` purchases (refunds) subtract.
All payment types (`Cash`, `Check`, `CreditCard`) count.

**Reconciliation view** (shown alongside, not part of the cash math):

- *Booked total* — all Bill + Purchase lines coded to the account and dated in
  the month, regardless of payment status (the accrual number, for comparison).
- *Vendor credits applied* — payment lines linked to `VendorCredit` txns, for
  context only.
- A transaction-level breakdown (date, vendor, source, payment method, amount
  attributed) so the number can be audited line-by-line against a bank/card
  statement.
- JournalEntries or Deposits touching the account are flagged as warnings (out
  of scope for v1 — a possible "Bucket 3" later).

## Stack

Node.js + TypeScript + Express · `intuit-oauth` (OAuth2) · `node-quickbooks`
(API calls) · PostgreSQL (encrypted token storage + monthly result cache) ·
vanilla-JS dashboard with Chart.js.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | Dashboard (month picker, headline number, reconciliation, trailing-12-month chart) |
| `GET /health` | 200 OK for Railway's health check |
| `GET /connect` | Kick off the Intuit OAuth consent flow |
| `GET /callback` | OAuth redirect target — stores encrypted tokens + `realmId` |
| `GET /api/inventory-spend?month=YYYY-MM` | `{ total, bucket1Total, bucket2Total, bookedTotal, vendorCreditsApplied, transactions, warnings }` — add `&refresh=1` to bypass the cache |
| `GET /api/inventory-spend/trend?months=12` | The same math batched over the last N months |
| `GET /api/status` | Connection status + token staleness warning |

## Environment variables (Railway)

```
QBO_CLIENT_ID            # from the Intuit developer app
QBO_CLIENT_SECRET
QBO_ENVIRONMENT          # "sandbox" or "production"
QBO_REDIRECT_URI         # must exactly match the Intuit app's registered redirect URI
TOKEN_ENCRYPTION_KEY     # any long random string; encrypts tokens at rest (AES-256-GCM)
DATABASE_URL             # Railway Postgres plugin provides this automatically
```

Optional: `QBO_INVENTORY_ACCOUNT_NAME` (defaults to `Material Inventory`),
`DATABASE_SSL=true` if connecting to Postgres over Railway's public proxy,
`PORT` (Railway sets this).

## Deploying on Railway

1. Create a Railway project from this repo (Nixpacks auto-detects Node; `railway.json`
   sets the `/health` health check).
2. Add the **PostgreSQL** plugin and reference its `DATABASE_URL` in the service.
3. Set the env vars above. The app boots fine with none of them (`/health` still
   works) so you can deploy the shell first.
4. In the [Intuit developer portal](https://developer.intuit.com), register
   `https://<your-app>.up.railway.app/callback` as the redirect URI — it must
   match `QBO_REDIRECT_URI` exactly.
5. Open `https://<your-app>.up.railway.app/connect`, sign in, and pick the company.
6. Start against **sandbox** credentials; when the math checks out, swap
   `QBO_CLIENT_ID/SECRET/ENVIRONMENT` to production, reconnect, run one real
   recent month, and cross-check the breakdown table against the actual bank and
   credit-card statements before trusting the number.

## Token lifecycle

- Access tokens last 1 hour; each API request refreshes proactively when <5 min
  remain. Refresh tokens rotate on every refresh and the newest one always
  overwrites the stored one.
- Intuit disconnects apps that go ~100 days without a refresh, and forces a full
  reauthorization after 5 years. The dashboard shows a warning banner (and the
  server logs a warning) as either limit approaches; fix is just visiting
  `/connect` again.

## Local development

```
npm install
npm run dev      # tsx watch, http://localhost:3000
npm test         # unit tests for the allocation math
npm run build    # tsc → dist/
```

## Out of scope for v1

- Multi-company support — single-company internal tool, tokens are one row.
- Deposits/Journal Entries hitting Material Inventory outside the Bill/Purchase
  flow — detected and surfaced as warnings so we can decide on a "Bucket 3".
- Public app-store distribution.
