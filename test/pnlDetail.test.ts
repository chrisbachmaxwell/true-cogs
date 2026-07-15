import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonthlyPnl, PnlContext } from '../src/pnl';
import { computePnlDetail, expenseAccountDetail } from '../src/pnlDetail';
import type { QboApi } from '../src/qbo';

const BANK = '35';
const RETAIL = '40100id';
const REBATES = '50500id';
const ADVERTISING = '60100id';

function ctx(): PnlContext {
  return {
    bankAccountIds: [BANK],
    retailIncomeAccountIds: [RETAIL],
    accountTypes: new Map([
      [RETAIL, 'Income'],
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

const FIXTURE = {
  Deposit: [
    {
      Id: 'd1', TxnDate: '2026-06-02', TotalAmt: 1150,
      DepositToAccountRef: { value: BANK },
      Line: [depositLine(RETAIL, 1000), depositLine(REBATES, 100), depositLine(ADVERTISING, 50)],
    },
    { // non-bank deposit: excluded from income AND from the detail lists
      Id: 'd2', TxnDate: '2026-06-03', TotalAmt: 500,
      DepositToAccountRef: { value: 'not-a-bank' },
      Line: [depositLine(RETAIL, 500)],
    },
  ],
  Payment: [
    { Id: 'p1', TxnDate: '2026-06-05', TotalAmt: 2140, DepositToAccountRef: { value: BANK }, CustomerRef: { name: 'Boise' } },
    { Id: 'p2', TxnDate: '2026-06-06', TotalAmt: 750, DepositToAccountRef: { value: 'credit-memos' }, CustomerRef: { name: 'Boise' } },
  ],
  SalesReceipt: [
    { Id: 's1', TxnDate: '2026-06-07', TotalAmt: 1300, DepositToAccountRef: { value: BANK }, CustomerRef: { name: 'Walk-in' } },
  ],
  RefundReceipt: [
    { Id: 'r1', TxnDate: '2026-06-08', TotalAmt: 200, DepositToAccountRef: { value: BANK }, CustomerRef: { name: 'Return' } },
  ],
};

test('detail lists sum exactly to the statement lines computeMonthlyPnl produces', async () => {
  const api = mockApi(FIXTURE);
  const pnl = await computeMonthlyPnl(api, ctx(), '2026-06', 0);
  const detail = await computePnlDetail(api, ctx(), '2026-06');
  assert.equal(detail.sums.deposits, pnl.retailCashIn.deposits);
  assert.equal(detail.sums.invoicePayments, pnl.retailCashIn.invoicePayments);
  assert.equal(detail.sums.salesReceipts, pnl.retailCashIn.salesReceipts);
  assert.equal(detail.sums.refunds, pnl.retailCashIn.refunds);
  assert.equal(detail.sums.rebates, pnl.cogsOffsets);
  assert.equal(detail.sums.reimbursements, pnl.expenseOffsets);
});

test('non-bank payments and deposits never appear in the detail rows', async () => {
  const detail = await computePnlDetail(mockApi(FIXTURE), ctx(), '2026-06');
  assert.equal(detail.invoicePayments.length, 1);
  assert.equal(detail.invoicePayments[0].txnId, 'p1');
  assert.equal(detail.deposits.length, 1);
  assert.equal(detail.deposits[0].txnId, 'd1');
});

test('rows carry ids and types for QuickBooks deep links', async () => {
  const detail = await computePnlDetail(mockApi(FIXTURE), ctx(), '2026-06');
  assert.equal(detail.deposits[0].txnType, 'Deposit');
  assert.equal(detail.refunds[0].txnType, 'RefundReceipt');
  assert.equal(detail.refunds[0].txnId, 'r1');
});

test('expense account detail signs: bills and purchases add, credits/JE-credits/deposits subtract', async () => {
  const expLine = (amount: number) => ({
    DetailType: 'AccountBasedExpenseLineDetail',
    Amount: amount,
    AccountBasedExpenseLineDetail: { AccountRef: { value: ADVERTISING } },
  });
  const api = mockApi({
    Bill: [{ Id: 'b1', TxnDate: '2026-06-01', VendorRef: { name: 'AdCo' }, Line: [expLine(400)] }],
    Purchase: [
      { Id: 'x1', TxnDate: '2026-06-02', PaymentType: 'Check', EntityRef: { name: 'AdCo' }, Line: [expLine(100)] },
      { Id: 'x2', TxnDate: '2026-06-03', Credit: true, EntityRef: { name: 'AdCo' }, Line: [expLine(30)] },
    ],
    VendorCredit: [{ Id: 'v1', TxnDate: '2026-06-04', VendorRef: { name: 'AdCo' }, Line: [expLine(20)] }],
    JournalEntry: [{
      Id: 'j1', TxnDate: '2026-06-05',
      Line: [{
        DetailType: 'JournalEntryLineDetail',
        Amount: 50,
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: ADVERTISING } },
      }],
    }],
    Deposit: [{
      Id: 'd9', TxnDate: '2026-06-06', DepositToAccountRef: { value: BANK },
      Line: [depositLine(ADVERTISING, 25)],
    }],
  });
  const r = await expenseAccountDetail(api, ADVERTISING, '2026-06-01', '2026-06-30');
  // 400 + 100 − 30 − 20 − 50 − 25 = 375
  assert.equal(r.sum, 375);
  const check = r.rows.find((row) => row.txnId === 'x1');
  assert.equal(check?.txnType, 'Check');
  assert.equal(r.rows.find((row) => row.txnId === 'x2')?.amount, -30);
});
