import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCashFlow, reportBalances } from '../src/cashflow';
import type { QboApi } from '../src/qbo';

function report(rows: [string, string, number][]) {
  return {
    Rows: {
      Row: [
        {
          Rows: {
            Row: rows.map(([id, name, value]) => ({
              ColData: [{ id, value: name }, { value: String(value) }],
            })),
          },
        },
        { ColData: [{ value: 'Total (no id — skipped)' }, { value: '999999' }] },
      ],
    },
  };
}

const ACCOUNTS = [
  { Id: '1', Name: 'Checking', AcctNum: '10400', AccountType: 'Bank' },
  { Id: '2', Name: 'Material Inventory', AcctNum: '11900', AccountType: 'Other Current Asset' },
  { Id: '3', Name: 'Amex', AcctNum: '20303', AccountType: 'Credit Card' },
  { Id: '4', Name: 'Retained Earnings', AcctNum: null, AccountType: 'Equity' },
  { Id: '5', Name: 'Distributions', AcctNum: '30600', AccountType: 'Equity' },
];

function mockApi(before: any, after: any): QboApi {
  return {
    async queryByDateRange() { return []; },
    async getBill() { throw new Error('unused'); },
    async getInvoice() { throw new Error('unused'); },
    async listAccounts() { return ACCOUNTS; },
    async listItems() { return []; },
    async balanceSheet(asOf: string) { return asOf === '2025-12-31' ? before : after; },
  };
}

test('reportBalances flattens leaf accounts and skips id-less totals', () => {
  const m = reportBalances(report([['1', 'Checking', 100], ['2', 'Material Inventory', 50]]));
  assert.equal(m.size, 2);
  assert.equal(m.get('1')?.value, 100);
});

test('cash flow: bank change separated; asset growth uses cash, liability growth frees it', async () => {
  const before = report([
    ['1', 'Checking', 1000],
    ['2', 'Material Inventory', 500],
    ['3', 'Amex', 200],
    ['4', 'Retained Earnings', 9000],
    ['5', 'Distributions', -100],
  ]);
  const after = report([
    ['1', 'Checking', 1300],
    ['2', 'Material Inventory', 900],
    ['3', 'Amex', 350],
    ['4', 'Retained Earnings', 12000],
    ['5', 'Distributions', -250],
  ]);
  const r = await computeCashFlow(mockApi(before, after), '2025-12-31', '2026-06-30');
  assert.equal(r.bankChange, 300);
  assert.equal(r.bankAccounts.length, 1);
  const inv = r.moves.find((m) => m.name === 'Material Inventory')!;
  assert.equal(inv.change, 400);
  assert.equal(inv.cashEffect, -400); // asset up = cash absorbed
  const amex = r.moves.find((m) => m.name === 'Amex')!;
  assert.equal(amex.cashEffect, 150); // liability up = cash freed
  const dist = r.moves.find((m) => m.name === 'Distributions')!;
  assert.equal(dist.cashEffect, -150); // equity down = cash out
  assert.equal(r.moves.find((m) => /Retained/.test(m.name)), undefined); // earnings excluded
  assert.equal(r.moves[0].name, 'Material Inventory'); // sorted by |effect|
});
