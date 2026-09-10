import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReclassify, planRevert } from '../src/reclassify';

const CFG = {
  zionsId: 'zions',
  toId: 'ach',
  toName: 'ACH',
  fromIds: new Set(['inv1', 'inv2']),
  expectedAmount: 500,
};

function purchase(over: any = {}) {
  return {
    Id: '42',
    SyncToken: '3',
    AccountRef: { value: 'zions' },
    Line: [
      {
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: 500,
        AccountBasedExpenseLineDetail: { AccountRef: { value: 'inv1' } },
      },
    ],
    ...over,
  };
}

test('happy path: inventory line re-pointed at the clearing account', () => {
  const p = planReclassify(purchase(), CFG);
  assert.equal(p.ok, true);
  assert.equal(p.moving, 500);
  assert.equal(p.updated.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, 'ach');
  assert.equal(p.updated.Id, '42'); // SyncToken and identity preserved
  assert.equal(p.updated.SyncToken, '3');
});

test('mixed lines: only inventory lines move, others untouched', () => {
  const p = planReclassify(
    purchase({
      Line: [
        { DetailType: 'AccountBasedExpenseLineDetail', Amount: 480, AccountBasedExpenseLineDetail: { AccountRef: { value: 'inv2' } } },
        { DetailType: 'AccountBasedExpenseLineDetail', Amount: 20, AccountBasedExpenseLineDetail: { AccountRef: { value: 'inv1' } } },
        { DetailType: 'AccountBasedExpenseLineDetail', Amount: 75, AccountBasedExpenseLineDetail: { AccountRef: { value: 'freight' } } },
      ],
    }),
    CFG
  );
  assert.equal(p.ok, true);
  assert.equal(p.moving, 500);
  assert.equal(p.updated.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, 'ach');
  assert.equal(p.updated.Line[1].AccountBasedExpenseLineDetail.AccountRef.value, 'ach');
  assert.equal(p.updated.Line[2].AccountBasedExpenseLineDetail.AccountRef.value, 'freight');
});

test('refuses: wrong funding account (the Amex case Chris caught)', () => {
  const p = planReclassify(purchase({ AccountRef: { value: 'amex' } }), CFG);
  assert.equal(p.ok, false);
  assert.match(p.reason, /not paid from the expected funding account/);
});

test('refuses: no source-coded lines (the employee-loan case Chris caught)', () => {
  const p = planReclassify(
    purchase({ Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 500, AccountBasedExpenseLineDetail: { AccountRef: { value: 'loan' } } }] }),
    CFG
  );
  assert.equal(p.ok, false);
  assert.match(p.reason, /no lines coded to the expected source account/);
});

test('refuses: amount drifted from the manifest expectation', () => {
  const p = planReclassify(purchase(), { ...CFG, expectedAmount: 480 });
  assert.equal(p.ok, false);
  assert.match(p.reason, /transaction changed since matching/);
});

test('refuses: already reclassified (idempotent)', () => {
  const p = planReclassify(
    purchase({ Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 500, AccountBasedExpenseLineDetail: { AccountRef: { value: 'ach' } } }] }),
    CFG
  );
  assert.equal(p.ok, false);
  assert.match(p.reason, /already reclassified/);
});

test('refuses: credits, missing txn, missing SyncToken', () => {
  assert.equal(planReclassify(purchase({ Credit: true }), CFG).ok, false);
  assert.equal(planReclassify(null, CFG).ok, false);
  assert.equal(planReclassify(purchase({ SyncToken: undefined }), CFG).ok, false);
});

test('allowCredit: card-side autopay credit re-pointed at the wash', () => {
  // The 2026 autopay-record repair: a credit funded from the card itself,
  // category also the card — allowCredit + fundedFrom=the card lets it through.
  const cfg = { zionsId: 'purple', toId: 'wash', toName: 'Credit Cards', fromIds: new Set(['purple']), expectedAmount: 500, allowCredit: true };
  const p = planReclassify(
    purchase({ Credit: true, AccountRef: { value: 'purple' }, Line: [{ DetailType: 'AccountBasedExpenseLineDetail', Amount: 500, AccountBasedExpenseLineDetail: { AccountRef: { value: 'purple' } } }] }),
    cfg
  );
  assert.equal(p.ok, true);
  assert.equal(p.updated.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, 'wash');
  assert.equal(p.updated.Credit, true); // the credit flag itself is untouched
});

test('allowCredit still enforces the funding account', () => {
  const cfg = { zionsId: 'purple', toId: 'wash', toName: 'Credit Cards', fromIds: new Set(['purple']), expectedAmount: 500, allowCredit: true };
  const p = planReclassify(purchase({ Credit: true, AccountRef: { value: 'zions' } }), cfg);
  assert.equal(p.ok, false);
  assert.match(p.reason, /not paid from the expected funding account/);
});

test('revert restores the before-image lines onto the live object', () => {
  const before = purchase();
  const live = planReclassify(before, CFG).updated;
  live.SyncToken = '4'; // QBO bumps it after our write
  const r = planRevert(live, before);
  assert.equal(r.ok, true);
  assert.equal(r.updated.SyncToken, '4'); // fresh token kept
  assert.equal(r.updated.Line[0].AccountBasedExpenseLineDetail.AccountRef.value, 'inv1');
});

test('revert refuses a mismatched before-image', () => {
  const r = planRevert(purchase(), { Id: '99', Line: [] });
  assert.equal(r.ok, false);
});
