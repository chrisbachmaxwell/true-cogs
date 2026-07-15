import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonthlyPnl } from '../src/pnl';
import type { QboApi } from '../src/qbo';

const BANK = '35';
const UNDEPOSITED = '4';

function mockApi(data: Record<string, any[]>): QboApi {
  return {
    async queryByDateRange(entity) {
      return data[entity] || [];
    },
    async getBill() {
      throw new Error('not used');
    },
    async listAccounts() {
      return [];
    },
  };
}

test('customer money in: receipts + payments - refunds', async () => {
  const api = mockApi({
    SalesReceipt: [
      { TotalAmt: 1000, DepositToAccountRef: { value: UNDEPOSITED } },
      { TotalAmt: 500, DepositToAccountRef: { value: BANK } },
    ],
    Payment: [{ TotalAmt: 2000, DepositToAccountRef: { value: UNDEPOSITED } }],
    RefundReceipt: [{ TotalAmt: 100 }],
    Deposit: [{ TotalAmt: 2900, DepositToAccountRef: { value: BANK } }],
  });
  const r = await computeMonthlyPnl(api, [BANK], '2026-06', 1200);
  assert.equal(r.customerMoneyIn.total, 3400); // 1500 + 2000 - 100
  assert.equal(r.grossProfit, 2200);
  assert.equal(r.grossMarginPct, 64.71);
});

test('bank inflows: bank deposits + direct-to-bank receipts/payments only', async () => {
  const api = mockApi({
    SalesReceipt: [
      { TotalAmt: 500, DepositToAccountRef: { value: BANK } },
      { TotalAmt: 999, DepositToAccountRef: { value: UNDEPOSITED } },
    ],
    Payment: [{ TotalAmt: 300, DepositToAccountRef: { value: BANK } }],
    Deposit: [
      { TotalAmt: 2900, DepositToAccountRef: { value: BANK } },
      { TotalAmt: 777, DepositToAccountRef: { value: UNDEPOSITED } },
    ],
  });
  const r = await computeMonthlyPnl(api, [BANK], '2026-06', 0);
  assert.equal(r.bankInflows.total, 3700); // 2900 + 500 + 300
  assert.equal(r.warnings.length, 1); // the non-bank deposit is flagged
});

test('empty month yields zeros and null margin', async () => {
  const r = await computeMonthlyPnl(mockApi({}), [BANK], '2026-06', 0);
  assert.equal(r.customerMoneyIn.total, 0);
  assert.equal(r.bankInflows.total, 0);
  assert.equal(r.grossMarginPct, null);
});
