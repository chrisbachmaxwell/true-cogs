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
  vendorCredits?: any[];
  journalEntries?: any[];
  deposits?: any[];
}): QboApi {
  return {
    async queryByDateRange(entity) {
      if (entity === 'BillPayment') return data.billPayments || [];
      if (entity === 'Purchase') return data.purchases || [];
      if (entity === 'Bill') return data.billsInMonth || [];
      if (entity === 'VendorCredit') return data.vendorCredits || [];
      if (entity === 'JournalEntry') return data.journalEntries || [];
      if (entity === 'Deposit') return data.deposits || [];
      return [];
    },
    async getBill(id) {
      const bill = data.bills?.[id];
      if (!bill) throw new Error(`no mock bill ${id}`);
      return bill;
    },
    async listAccounts() {
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

test('bucket 1: vendor-discount bill never attributes more than cash paid', async () => {
  // Bill: $145.60 inventory + a -$5.09 vendor-discount line = $140.51 total.
  // Old formula (divide by TotalAmt) attributed $145.60 from a $140.51 payment.
  // Dividing by the positive charge lines caps attribution at the cash paid.
  const api = mockApi({
    bills: {
      'B6': {
        Id: 'B6',
        TotalAmt: 140.51,
        Line: [
          expenseLine(MAT_INV, 145.6),
          { DetailType: 'AccountBasedExpenseLineDetail', Amount: -5.09,
            AccountBasedExpenseLineDetail: { AccountRef: { value: OTHER } } },
        ],
      },
    },
    billPayments: [
      {
        Id: 'BP6',
        TxnDate: '2026-06-12',
        PayType: 'Check',
        VendorRef: { name: 'Nikon' },
        Line: [{ Amount: 140.51, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B6' }] }],
      },
    ],
  });
  const r = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(r.bucket1Total, 140.51);
});

test('bucket 1: discount on a mixed bill spreads pro-rata across charge lines', async () => {
  // $100 inventory + $50 freight - $10 discount = $140 paid in full.
  // Inventory share of charges = 100/150, so attribution = 140 × 2/3 = 93.33.
  const api = mockApi({
    bills: {
      'B7': {
        Id: 'B7',
        TotalAmt: 140,
        Line: [
          expenseLine(MAT_INV, 100),
          expenseLine(OTHER, 50),
          { DetailType: 'AccountBasedExpenseLineDetail', Amount: -10,
            AccountBasedExpenseLineDetail: { AccountRef: { value: OTHER } } },
        ],
      },
    },
    billPayments: [
      {
        Id: 'BP7',
        TxnDate: '2026-06-13',
        PayType: 'Check',
        Line: [{ Amount: 140, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B7' }] }],
      },
    ],
  });
  const r = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(r.bucket1Total, 93.33);
});

test('multiple inventory accounts (11900 + 11901 Boise) both count', async () => {
  const BOISE = '92';
  const api = mockApi({
    bills: {
      'B8': { Id: 'B8', TotalAmt: 1000, Line: [expenseLine(BOISE, 1000)] },
    },
    billPayments: [
      {
        Id: 'BP8',
        TxnDate: '2026-06-20',
        PayType: 'Check',
        VendorRef: { name: 'Boise vendor' },
        Line: [{ Amount: 1000, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B8' }] }],
      },
    ],
    purchases: [
      { Id: 'P8', TxnDate: '2026-06-21', PaymentType: 'CreditCard', Line: [expenseLine(MAT_INV, 250)] },
    ],
  });
  const r = await computeMonthlySpend(api, [MAT_INV, BOISE], '2026-06');
  assert.equal(r.bucket1Total, 1000);
  assert.equal(r.bucket2Total, 250);
  assert.equal(r.total, 1250);
  // Single-id call still works and excludes the other account
  const single = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(single.total, 250);
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

test('payments funded from an excluded clearing account are left out and reported', async () => {
  const bill = { Id: 'B1', TotalAmt: 1000, Line: [expenseLine(MAT_INV, 1000)] };
  const api = mockApi({
    billPayments: [
      {
        Id: 'BP-real', TxnDate: '2026-06-05', PayType: 'Check',
        VendorRef: { name: 'Canon' },
        CheckPayment: { BankAccountRef: { value: 'zions' } },
        Line: [{ Amount: 600, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B1' }] }],
      },
      {
        Id: 'BP-ach', TxnDate: '2026-06-06', PayType: 'Check',
        VendorRef: { name: 'Canon' },
        CheckPayment: { BankAccountRef: { value: 'ach' } },
        Line: [{ Amount: 400, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B1' }] }],
      },
    ],
    purchases: [
      { Id: 'P-ach', TxnDate: '2026-06-07', PaymentType: 'Check', AccountRef: { value: 'ach' }, Line: [expenseLine(MAT_INV, 250)] },
      { Id: 'P-real', TxnDate: '2026-06-08', PaymentType: 'Cash', AccountRef: { value: 'zions' }, Line: [expenseLine(MAT_INV, 100)] },
    ],
    bills: { B1: bill },
  });
  const excl = { excludeFundingAccounts: { ids: new Set(['ach']), label: '"ACH"' } };
  const r = await computeMonthlySpend(api, MAT_INV, '2026-06', excl);
  assert.equal(r.total, 700); // 600 real bill payment + 100 real purchase
  assert.equal(r.excludedFundingTotal, 650); // 400 ACH payment + 250 ACH purchase
  assert.ok(r.transactions.every((t) => t.txnId !== 'BP-ach' && t.txnId !== 'P-ach'));
  assert.ok(r.warnings.some((w) => w.includes('Excluded $650.00') && w.includes('ACH')));
  // Without the option, everything counts and nothing is flagged.
  const r2 = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(r2.total, 1350);
  assert.equal(r2.excludedFundingTotal, 0);
});

test('inventory received nets vendor credits and splits its components', async () => {
  const api = mockApi({
    billsInMonth: [{ Id: 'B9', TotalAmt: 9000, Line: [expenseLine(MAT_INV, 9000)] }],
    purchases: [
      { Id: 'P9', TxnDate: '2026-06-05', PaymentType: 'Cash', Line: [expenseLine(MAT_INV, 500)] },
    ],
    vendorCredits: [{ Id: 'VC9', TotalAmt: 300, Line: [expenseLine(MAT_INV, 300)] }],
  });
  const r = await computeMonthlySpend(api, MAT_INV, '2026-06');
  assert.equal(r.billedTotal, 9000);
  assert.equal(r.directBoughtTotal, 500);
  assert.equal(r.vendorCreditBooked, 300);
  assert.equal(r.bookedTotal, 9200); // 9000 + 500 − 300
});

test('purchases settled: each bill counts at what we paid for it, on its date', async () => {
  const api = mockApi({
    billsInMonth: [
      // Fully settled: $100 bill, $70 cash + $30 credits → counts $70.
      { Id: 'B10', TxnDate: '2026-06-03', TotalAmt: 100, Balance: 0, VendorRef: { name: 'Canon' }, Line: [expenseLine(MAT_INV, 100)] },
      // Open: $200 bill, $50 cash so far, $120 still owed → counts $170 ($30 credits already netted).
      { Id: 'B11', TxnDate: '2026-06-10', TotalAmt: 200, Balance: 120, VendorRef: { name: 'Sony' }, Line: [expenseLine(MAT_INV, 200)] },
      // Non-inventory bill — ignored.
      { Id: 'B12', TxnDate: '2026-06-11', TotalAmt: 50, Balance: 0, Line: [expenseLine(OTHER, 50)] },
    ],
    billPayments: [
      { Id: 'BP10', TxnDate: '2026-06-20', Line: [{ Amount: 70, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B10' }] }] },
      // Payment next period still attributes to the June bill.
      { Id: 'BP11', TxnDate: '2026-07-05', Line: [{ Amount: 50, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B11' }] }] },
    ],
    purchases: [
      { Id: 'P10', TxnDate: '2026-06-15', PaymentType: 'Cash', Line: [expenseLine(MAT_INV, 25)] },
    ],
  });
  const { computePurchasesSettled } = await import('../src/inventorySpend');
  const r = await computePurchasesSettled(api, MAT_INV, { start: '2026-06-01', end: '2026-06-30' }, '2026-07-17');
  assert.equal(r.billedNet, 240); // 70 + 170
  assert.equal(r.directTotal, 25);
  assert.equal(r.total, 265);
  assert.equal(r.creditsNetted, 60); // 30 + 30
  assert.equal(r.openBillCount, 1);
  const b10 = r.transactions.find((t) => t.txnId === 'B10');
  assert.equal(b10?.amount, 70);
  assert.equal(b10?.date, '2026-06-03'); // bill date, not payment date
});

test('purchases settled: credit-application lines (linked to both credit and bill) are not cash', async () => {
  const api = mockApi({
    billsInMonth: [
      { Id: 'B20', TxnDate: '2026-06-03', TotalAmt: 100, Balance: 0, VendorRef: { name: 'Canon' }, Line: [expenseLine(MAT_INV, 100)] },
    ],
    billPayments: [
      {
        Id: 'BP20', TxnDate: '2026-06-20',
        Line: [
          { Amount: 70, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B20' }] },
          // $30 credit applied to the same bill — links both docs; NOT cash.
          { Amount: 30, LinkedTxn: [{ TxnType: 'VendorCredit', TxnId: 'VC20' }, { TxnType: 'Bill', TxnId: 'B20' }] },
        ],
      },
    ],
  });
  const { computePurchasesSettled } = await import('../src/inventorySpend');
  const r = await computePurchasesSettled(api, MAT_INV, { start: '2026-06-01', end: '2026-06-30' }, '2026-07-17');
  assert.equal(r.billedNet, 70);
  assert.equal(r.creditsNetted, 30);
});
