import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonthlyPnl, depositRetailPortion, PnlContext } from '../src/pnl';
import type { QboApi } from '../src/qbo';

const BANK = '35';
const UNDEPOSITED = '4';
const RETAIL = '40100id';
const SALES_TAX = '2100id';
const REBATES = '50500id';
const ADVERTISING = '60100id';

function ctx(): PnlContext {
  return {
    bankAccountIds: [BANK],
    retailIncomeAccountIds: [RETAIL],
    accountTypes: new Map([
      [RETAIL, 'Income'],
      [SALES_TAX, 'Other Current Liability'],
      [REBATES, 'Cost of Goods Sold'],
      [ADVERTISING, 'Expense'],
    ]),
  };
}

function depositLine(accountId: string, amount: number) {
  return {
    DetailType: 'DepositLineDetail',
    Amount: amount,
    DepositLineDetail: { AccountRef: { value: accountId } },
  };
}

function mockApi(data: Record<string, any[]>): QboApi {
  return {
    async queryByDateRange(entity) {
      return data[entity] || [];
    },
    async getBill() { throw new Error('not used'); },
    async getInvoice() { throw new Error('not used'); },
    async listAccounts() { return []; },
    async listItems() { return []; },
    async balanceSheet() { return {}; },
  };
}

test('POS daily-summary deposit: only income lines count; tax and fees excluded', async () => {
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
  assert.equal(r.retailCashIn.deposits, 10000);
  assert.equal(r.retailCashIn.total, 10000);
  assert.equal(r.grossProfit, 4000);
  assert.equal(r.bankInflows.total, 10450);
});

test('bank-landed payments and receipts count at full tax-inclusive value; refunds subtract', async () => {
  const api = mockApi({
    SalesReceipt: [{ TotalAmt: 1300, DepositToAccountRef: { value: BANK } }],
    Payment: [{ TotalAmt: 2140, DepositToAccountRef: { value: BANK } }],
    RefundReceipt: [{ TotalAmt: 200, DepositToAccountRef: { value: BANK } }],
  });
  const r = await computeMonthlyPnl(api, ctx(), '2026-06', 0);
  assert.equal(r.retailCashIn.salesReceipts, 1300);
  assert.equal(r.retailCashIn.invoicePayments, 2140);
  assert.equal(r.retailCashIn.refunds, 200);
  assert.equal(r.retailCashIn.total, 3240);
});

test('payments settled into non-bank accounts (store credit) are excluded and flagged', async () => {
  const api = mockApi({
    Payment: [
      { TotalAmt: 1000, DepositToAccountRef: { value: BANK } },
      { TotalAmt: 750, DepositToAccountRef: { value: 'credit-memos-asset' } },
      { TotalAmt: 50 }, // no deposit account at all
    ],
  });
  const r = await computeMonthlyPnl(api, ctx(), '2026-06', 0);
  assert.equal(r.retailCashIn.invoicePayments, 1000);
  assert.equal(r.retailCashIn.total, 1000);
  assert.ok(r.warnings.some((w) => w.includes('800.00')));
});

test('sales tax remitted nets against revenue exactly once', async () => {
  const api = mockApi({
    Deposit: [
      { TotalAmt: 1070, DepositToAccountRef: { value: BANK }, Line: [depositLine(RETAIL, 1070)] },
    ],
  });
  const r = await computeMonthlyPnl(api, ctx(), '2026-06', 500, 70);
  assert.equal(r.retailCashIn.total, 1070); // tax-inclusive gross
  assert.equal(r.salesTaxRemitted, 70);
  assert.equal(r.revenueNet, 1000);
  assert.equal(r.grossProfit, 500);
  assert.equal(r.grossMarginPct, 50);
});

test('deposited vendor rebates reduce COGS; expense reimbursements tracked separately', async () => {
  const api = mockApi({
    Deposit: [
      {
        TotalAmt: 1150,
        DepositToAccountRef: { value: BANK },
        Line: [
          depositLine(RETAIL, 1000),
          depositLine(REBATES, 100),
          depositLine(ADVERTISING, 50),
        ],
      },
    ],
  });
  const r = await computeMonthlyPnl(api, ctx(), '2026-06', 600);
  assert.equal(r.retailCashIn.total, 1000); // rebates/reimbursements are not revenue
  assert.equal(r.cogsOffsets, 100);
  assert.equal(r.expenseOffsets, 50);
  assert.equal(r.grossProfit, 500); // 1000 − 600 + 100
});

test('income-coded deposits to non-bank accounts are excluded and flagged', async () => {
  const api = mockApi({
    Deposit: [
      { TotalAmt: 500, DepositToAccountRef: { value: UNDEPOSITED }, Line: [depositLine(RETAIL, 500)] },
    ],
  });
  const r = await computeMonthlyPnl(api, ctx(), '2026-06', 0);
  assert.equal(r.retailCashIn.total, 0);
  assert.equal(r.warnings.length, 1);
});

test('portion helper ignores unrelated line types', () => {
  assert.equal(
    depositRetailPortion(
      { Line: [depositLine(RETAIL, 100), { DetailType: 'Other', Amount: 50 }] },
      new Set([RETAIL])
    ),
    100
  );
});

test('empty month yields zeros and null margin', async () => {
  const r = await computeMonthlyPnl(mockApi({}), ctx(), '2026-06', 0);
  assert.equal(r.retailCashIn.total, 0);
  assert.equal(r.grossMarginPct, null);
});

test('feed refunds: bank-funded purchases coded to income accounts reduce income', async () => {
  const api = mockApi({
    Deposit: [
      {
        TotalAmt: 10000,
        DepositToAccountRef: { value: BANK },
        Line: [depositLine(RETAIL, 10000)],
      },
    ],
    Purchase: [
      // A PayPal refund out of the bank, coded straight to Retail Sales.
      {
        AccountRef: { value: BANK },
        Line: [
          {
            DetailType: 'AccountBasedExpenseLineDetail',
            Amount: 150,
            AccountBasedExpenseLineDetail: { AccountRef: { value: RETAIL } },
          },
        ],
      },
      // A credit reverses the sign.
      {
        AccountRef: { value: BANK },
        Credit: true,
        Line: [
          {
            DetailType: 'AccountBasedExpenseLineDetail',
            Amount: 40,
            AccountBasedExpenseLineDetail: { AccountRef: { value: RETAIL } },
          },
        ],
      },
      // Not bank-funded (Amex) — ignored.
      {
        AccountRef: { value: 'amex' },
        Line: [
          {
            DetailType: 'AccountBasedExpenseLineDetail',
            Amount: 999,
            AccountBasedExpenseLineDetail: { AccountRef: { value: RETAIL } },
          },
        ],
      },
      // Bank-funded but coded to an expense account — not income, ignored.
      {
        AccountRef: { value: BANK },
        Line: [
          {
            DetailType: 'AccountBasedExpenseLineDetail',
            Amount: 500,
            AccountBasedExpenseLineDetail: { AccountRef: { value: ADVERTISING } },
          },
        ],
      },
    ],
  });
  const r = await computeMonthlyPnl(api, ctx(), '2026-06', 0);
  assert.equal(r.retailCashIn.feedRefunds, 110); // 150 − 40
  assert.equal(r.retailCashIn.total, 9890);
  assert.equal(r.revenueNet, 9890);
});
