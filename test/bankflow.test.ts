import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBankFlow } from '../src/bankflow';
import type { QboApi } from '../src/qbo';

const BANK = '10';
const CARD = '20';
const UNDEP = '4';
const INV = '91';
const OTHER = '99';

function expenseLine(accountId: string, amount: number) {
  return {
    DetailType: 'AccountBasedExpenseLineDetail',
    Amount: amount,
    AccountBasedExpenseLineDetail: { AccountRef: { value: accountId } },
  };
}

function mockApi(data: Record<string, any[]>, bills: Record<string, any> = {}): QboApi {
  return {
    async queryByDateRange(entity) { return data[entity] || []; },
    async getBill(id) {
      const b = bills[id];
      if (!b) throw new Error(`no bill ${id}`);
      return b;
    },
    async getInvoice() { throw new Error('unused'); },
    async listAccounts() { return []; },
    async listItems() { return []; },
    async balanceSheet() { return {}; },
  };
}

test('bank flow: inflows and outflows categorized, uncategorized residual reported', async () => {
  const api = mockApi(
    {
      Deposit: [
        { TotalAmt: 5000, DepositToAccountRef: { value: BANK } },
        { TotalAmt: 700, DepositToAccountRef: { value: UNDEP } }, // not bank — excluded
      ],
      Payment: [{ TotalAmt: 300, DepositToAccountRef: { value: BANK } }],
      BillPayment: [
        {
          TotalAmt: 2000, PayType: 'Check', VendorRef: { name: 'Canon' },
          CheckPayment: { BankAccountRef: { value: BANK } },
          Line: [{ Amount: 2000, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B1' }] }],
        },
        { TotalAmt: 999, PayType: 'CreditCard', Line: [] }, // card-funded — excluded
      ],
      Purchase: [
        { TotalAmt: 400, AccountRef: { value: BANK }, EntityRef: { name: 'B&H' }, Line: [expenseLine(INV, 250), expenseLine(OTHER, 150)] },
        { TotalAmt: 100, AccountRef: { value: CARD }, Line: [expenseLine(INV, 100)] }, // card — excluded
      ],
      Transfer: [
        { Amount: 800, FromAccountRef: { value: BANK }, ToAccountRef: { value: CARD } }, // card pay-down
        { Amount: 50, FromAccountRef: { value: UNDEP }, ToAccountRef: { value: BANK } }, // inflow
        { Amount: 123, FromAccountRef: { value: BANK }, ToAccountRef: { value: BANK } }, // internal — ignored
      ],
    },
    { B1: { Id: 'B1', TotalAmt: 2000, Line: [expenseLine(INV, 1500), expenseLine(OTHER, 500)] } }
  );
  const r = await computeBankFlow(api, [BANK], [INV], '2026-06-01', '2026-06-30', 1000);
  assert.equal(r.inflows.total, 5350); // 5000 + 300 + 50
  assert.equal(r.outflows.billPayments, 2000);
  assert.equal(r.outflows.billPaymentsInventoryPortion, 1500); // 2000 × 1500/2000
  assert.equal(r.outflows.purchases, 400);
  assert.equal(r.outflows.purchasesInventoryPortion, 250);
  assert.equal(r.outflows.transfersToCards, 800);
  assert.equal(r.outflows.total, 3200);
  assert.equal(r.netCategorized, 2150);
  assert.equal(r.uncategorized, -1150); // 1000 actual − 2150 categorized
  assert.equal(r.warnings.length, 1);
  assert.equal(r.outflows.topVendors[0].vendor, 'Canon');
});
