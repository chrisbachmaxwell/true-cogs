import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonthlyPnl, depositRetailPortion, itemRetailPortion, PnlContext } from '../src/pnl';
import type { QboApi } from '../src/qbo';

const BANK = '35';
const UNDEPOSITED = '4';
const RETAIL = '40100id';
const SHIPPING_INCOME = '40200id';
const SALES_TAX = '2100id';

const RETAIL_ITEM = 'item-1';
const SHIPPING_ITEM = 'item-2';

function ctx(): PnlContext {
  return {
    bankAccountIds: [BANK],
    retailIncomeAccountIds: [RETAIL],
    itemIncomeAccount: new Map([
      [RETAIL_ITEM, RETAIL],
      [SHIPPING_ITEM, SHIPPING_INCOME],
    ]),
  };
}

function saleLine(itemId: string, amount: number) {
  return {
    DetailType: 'SalesItemLineDetail',
    Amount: amount,
    SalesItemLineDetail: { ItemRef: { value: itemId } },
  };
}

function depositLine(accountId: string, amount: number) {
  return {
    DetailType: 'DepositLineDetail',
    Amount: amount,
    DepositLineDetail: { AccountRef: { value: accountId } },
  };
}

function mockApi(data: Record<string, any[]>, invoices: Record<string, any> = {}): QboApi {
  return {
    async queryByDateRange(entity) {
      return data[entity] || [];
    },
    async getBill() {
      throw new Error('not used');
    },
    async getInvoice(id) {
      const inv = invoices[id];
      if (!inv) throw new Error(`no mock invoice ${id}`);
      return inv;
    },
    async listAccounts() {
      return [];
    },
    async listItems() {
      return [];
    },
  };
}

test('POS daily-summary deposit: only retail lines count', async () => {
  // Typical POS deposit: retail sales + sales tax − card fees = deposit total.
  const api = mockApi({
    Deposit: [
      {
        TotalAmt: 10450,
        DepositToAccountRef: { value: BANK },
        Line: [
          depositLine(RETAIL, 10000),
          depositLine(SALES_TAX, 700),
          depositLine('fees', -250),
        ],
      },
    ],
  });
  const r = await computeMonthlyPnl(api, ctx(), '2026-06', 6000);
  assert.equal(r.retailCashIn.deposits, 10000); // not 10450 — tax and fees excluded
  assert.equal(r.retailCashIn.total, 10000);
  assert.equal(r.grossProfit, 4000);
  assert.equal(r.bankInflows.total, 10450); // reference metric keeps the full deposit
});

test('sales receipts count only retail items; refunds subtract', async () => {
  const api = mockApi({
    SalesReceipt: [
      {
        TotalAmt: 1300,
        DepositToAccountRef: { value: UNDEPOSITED },
        Line: [saleLine(RETAIL_ITEM, 1200), saleLine(SHIPPING_ITEM, 100)],
      },
    ],
    RefundReceipt: [
      { TotalAmt: 200, Line: [saleLine(RETAIL_ITEM, 200)] },
    ],
  });
  const r = await computeMonthlyPnl(api, ctx(), '2026-06', 0);
  assert.equal(r.retailCashIn.salesReceipts, 1200);
  assert.equal(r.retailCashIn.refunds, 200);
  assert.equal(r.retailCashIn.total, 1000);
});

test('invoice payments allocate by the invoice retail ratio, mirroring COGS bucket 1', async () => {
  // Invoice: $3,000 retail + $1,000 shipping. Payment of $2,000 → 2,000 × 3/4 = 1,500.
  const api = mockApi(
    {
      Payment: [
        {
          TotalAmt: 2000,
          Line: [{ Amount: 2000, LinkedTxn: [{ TxnType: 'Invoice', TxnId: 'INV1' }] }],
        },
      ],
    },
    {
      INV1: {
        TotalAmt: 4000,
        Line: [saleLine(RETAIL_ITEM, 3000), saleLine(SHIPPING_ITEM, 1000)],
      },
    }
  );
  const r = await computeMonthlyPnl(api, ctx(), '2026-06', 0);
  assert.equal(r.retailCashIn.invoicePayments, 1500);
});

test('unmapped items are treated as non-retail and flagged', async () => {
  const api = mockApi({
    SalesReceipt: [{ TotalAmt: 500, Line: [saleLine('mystery-item', 500)] }],
  });
  const r = await computeMonthlyPnl(api, ctx(), '2026-06', 0);
  assert.equal(r.retailCashIn.total, 0);
  assert.equal(r.warnings.length, 1);
});

test('portion helpers ignore unrelated line types', () => {
  assert.equal(
    depositRetailPortion(
      { Line: [depositLine(RETAIL, 100), { DetailType: 'Other', Amount: 50 }] },
      new Set([RETAIL])
    ),
    100
  );
  assert.equal(
    itemRetailPortion(
      { Line: [saleLine(RETAIL_ITEM, 75), depositLine(RETAIL, 25)] },
      new Set([RETAIL]),
      new Map([[RETAIL_ITEM, RETAIL]])
    ),
    75
  );
});

test('empty month yields zeros and null margin', async () => {
  const r = await computeMonthlyPnl(mockApi({}), ctx(), '2026-06', 0);
  assert.equal(r.retailCashIn.total, 0);
  assert.equal(r.grossMarginPct, null);
});
