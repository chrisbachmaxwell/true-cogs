import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonthlySpend, inventoryPortionOfLines, monthDateRange } from '../src/inventorySpend';
import type { QboApi } from '../src/qbo';

const MAT_INV = '85';
const OTHER = '99';

function expenseLine(accountId: string, amount: number) {
  return {
    DetailType: 'AccountBasedExpenseLineDetail',
    Amount: amount,
    AccountBasedExpenseLineDetail: { AccountRef: { value: accountId } },
  };
}

function mockApi(data: {
  billPayments?: any[];
  purchases?: any[];
  bills?: Record<string, any>;
  billsInMonth?: any[];
  journalEntries?: any[];
  deposits?: any[];
}): QboApi {
  return {
    async queryByDateRange(entity) {
      if (entity === 'BillPayment') return data.billPayments || [];
      if (entity === 'Purchase') return data.purchases || [];
      if (entity === 'Bill') return data.billsInMonth || [];
      if (entity === 'JournalEntry') return data.journalEntries || [];
      if (entity === 'Deposit') return data.deposits || [];
      return [];
    },
    async getBill(id) {
      const bill = data.bills?.[id];
      if (!bill) throw new Error(`no mock bill ${id}`);
      return bill;
    },
    async findAccountsByName() {
      return [];
    },
  };
}

test('monthDateRange handles month lengths and leap years', () => {
  assert.deepEqual(monthDateRange('2026-06'), { start: '2026-06-01', end: '2026-06-30' });
  assert.deepEqual(monthDateRange('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
  assert.deepEqual(monthDateRange('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(monthDateRange('2026-12'), { start: '2026-12-01', end: '2026-12-31' });
  assert.throws(() => monthDateRange('2026-13'));
  assert.throws(() => monthDateRange('junk'));
});

test('inventoryPortionOfLines only counts matching account-based lines', () => {
  const bill = {
    Line: [
      expenseLine(MAT_INV, 100),
      expenseLine(OTHER, 50),
      { DetailType: 'ItemBasedExpenseLineDetail', Amount: 30 },
      expenseLine(MAT_INV, 25.5),
    ],
  };
  assert.equal(inventoryPortionOfLines(bill, MAT_INV), 125.5);
});

test('bucket 1: vendor-credit-at-payment scenario does not double count', async () => {
  // $20,000 bill fully coded to inventory; $2,000 vendor credit applied at payment
  // time so only $18,000 cash left the bank. Expect exactly 18,000.
  const api = mockApi({
    bills: {
      'B1': { Id: 'B1', TotalAmt: 20000, DocNumber: '1001', Line: [expenseLine(MAT_INV, 20000)] },
    },
    billPayments: [
      {
        Id: 'BP1',
        TxnDate: '2026-06-10',
        PayType: 'Check',
        VendorRef: { name: 'Canon' },
        Line: [
          { Amount: 18000, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B1' }] },
          { Amount: 2000, LinkedTxn: [{ TxnType: 'VendorCredit', TxnId: 'VC1' }] },
        ],
      },
    ],
  });
  const r = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(r.bucket1Total, 18000);
  assert.equal(r.total, 18000);
  assert.equal(r.vendorCreditsApplied, 2000);
  assert.equal(r.transactions.length, 1);
  assert.equal(r.transactions[0].paymentMethod, 'Check');
});

test('bucket 1: partial-inventory bill allocates by ratio', async () => {
  // Bill: $15,000 inventory + $5,000 freight = $20,000. Payment of $10,000 →
  // 10,000 × (15,000/20,000) = 7,500 attributed.
  const api = mockApi({
    bills: {
      'B2': {
        Id: 'B2',
        TotalAmt: 20000,
        Line: [expenseLine(MAT_INV, 15000), expenseLine(OTHER, 5000)],
      },
    },
    billPayments: [
      {
        Id: 'BP2',
        TxnDate: '2026-06-15',
        PayType: 'CreditCard',
        VendorRef: { name: 'Sony' },
        Line: [{ Amount: 10000, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B2' }] }],
      },
    ],
  });
  const r = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(r.bucket1Total, 7500);
  assert.equal(r.transactions[0].paymentMethod, 'CreditCard');
});

test('bucket 1: bill with no inventory lines contributes nothing', async () => {
  const api = mockApi({
    bills: { 'B3': { Id: 'B3', TotalAmt: 1000, Line: [expenseLine(OTHER, 1000)] } },
    billPayments: [
      {
        Id: 'BP3',
        TxnDate: '2026-06-20',
        PayType: 'Check',
        Line: [{ Amount: 1000, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B3' }] }],
      },
    ],
  });
  const r = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(r.total, 0);
  assert.equal(r.transactions.length, 0);
});

test('bucket 2: purchases add, Credit=true purchases subtract', async () => {
  const api = mockApi({
    purchases: [
      {
        Id: 'P1',
        TxnDate: '2026-06-05',
        PaymentType: 'CreditCard',
        EntityRef: { name: 'B&H' },
        Line: [expenseLine(MAT_INV, 500), expenseLine(OTHER, 40)],
      },
      {
        Id: 'P2',
        TxnDate: '2026-06-07',
        PaymentType: 'CreditCard',
        Credit: true,
        EntityRef: { name: 'B&H' },
        Line: [expenseLine(MAT_INV, 120)],
      },
      { Id: 'P3', TxnDate: '2026-06-08', PaymentType: 'Cash', Line: [expenseLine(OTHER, 60)] },
    ],
  });
  const r = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(r.bucket2Total, 380);
  assert.equal(r.total, 380);
  assert.equal(r.transactions.length, 2);
  assert.equal(r.transactions.find((t) => t.amount < 0)?.amount, -120);
});

test('booked total is accrual: unpaid bills count, payments of prior-month bills do not', async () => {
  // A bill dated this month but unpaid → booked only. A payment this month for a
  // bill dated earlier → cash only (bill not in the month's Bill query).
  const oldBill = { Id: 'OLD', TotalAmt: 4000, Line: [expenseLine(MAT_INV, 4000)] };
  const api = mockApi({
    bills: { OLD: oldBill },
    billsInMonth: [{ Id: 'NEW', TotalAmt: 9000, Line: [expenseLine(MAT_INV, 9000)] }],
    billPayments: [
      {
        Id: 'BP4',
        TxnDate: '2026-06-02',
        PayType: 'Check',
        Line: [{ Amount: 4000, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'OLD' }] }],
      },
    ],
  });
  const r = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(r.total, 4000);
  assert.equal(r.bookedTotal, 9000);
});

test('multiple payments against one bill fetch it once and both allocate', async () => {
  let fetches = 0;
  const api = mockApi({
    bills: {},
  });
  const bill = { Id: 'B5', TotalAmt: 1000, Line: [expenseLine(MAT_INV, 1000)] };
  api.getBill = async () => {
    fetches++;
    return bill;
  };
  (api as any).queryByDateRange = async (entity: string) => {
    if (entity === 'BillPayment') {
      return [
        { Id: 'BPa', TxnDate: '2026-06-01', PayType: 'Check', Line: [{ Amount: 600, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B5' }] }] },
        { Id: 'BPb', TxnDate: '2026-06-15', PayType: 'Check', Line: [{ Amount: 400, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B5' }] }] },
      ];
    }
    return [];
  };
  const r = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(r.bucket1Total, 1000);
  assert.equal(fetches, 1);
});

test('journal entries and deposits touching the account raise warnings, not totals', async () => {
  const api = mockApi({
    journalEntries: [
      { Id: 'JE1', Line: [{ JournalEntryLineDetail: { AccountRef: { value: MAT_INV } }, Amount: 999 }] },
    ],
    deposits: [
      { Id: 'D1', Line: [{ DepositLineDetail: { AccountRef: { value: MAT_INV } }, Amount: 50 }] },
    ],
  });
  const r = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(r.total, 0);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /JournalEntry/);
  assert.match(r.warnings[1], /Deposit/);
});
