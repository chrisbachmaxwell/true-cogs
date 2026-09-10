import { QboApi } from './qbo';

// "Where did the money go" between two balance-sheet snapshots. Every dollar of
// profit that didn't land in the bank shows up as a balance-sheet move: assets
// growing consume cash, liabilities/equity growing free it. Earnings rows
// (Net Income / Retained Earnings) are the *source* side and are excluded from
// the uses list.

export interface AccountMove {
  /** QBO account id — lets the UI drill into the account's transactions. */
  id: string;
  name: string;
  acctNum: string | null;
  type: string;
  before: number;
  after: number;
  change: number;
  /** Positive = freed cash for the bank; negative = absorbed cash. */
  cashEffect: number;
}

export interface CashFlowResult {
  asOfStart: string;
  asOfEnd: string;
  /** Net change across Bank-type accounts — the headline. */
  bankChange: number;
  bankAccounts: AccountMove[];
  /** Non-bank balance-sheet moves, largest cash effect first. */
  moves: AccountMove[];
  /** Sum of moves' cash effects (≈ what non-bank accounts did to the bank). */
  totalCashEffect: number;
  warnings: string[];
}

const LIABILITY_OR_EQUITY = new Set([
  'Credit Card',
  'Accounts Payable',
  'Other Current Liability',
  'Long Term Liability',
  'Equity',
]);

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Flattens QBO's nested report rows into id → value for leaf accounts. */
export function reportBalances(report: any): Map<string, { name: string; value: number }> {
  const out = new Map<string, { name: string; value: number }>();
  const walk = (rows: any) => {
    for (const row of rows?.Row || []) {
      const col = row.ColData;
      if (col?.length >= 2 && col[0]?.id) {
        const value = Number(col[col.length - 1]?.value);
        if (!Number.isNaN(value)) out.set(String(col[0].id), { name: col[0].value, value });
      }
      if (row.Rows) walk(row.Rows);
    }
  };
  walk(report?.Rows);
  return out;
}

export async function computeCashFlow(
  api: QboApi,
  asOfStart: string,
  asOfEnd: string
): Promise<CashFlowResult> {
  const [reportA, reportB, accounts] = [
    await api.balanceSheet(asOfStart),
    await api.balanceSheet(asOfEnd),
    await api.listAccounts(),
  ];
  const before = reportBalances(reportA);
  const after = reportBalances(reportB);
  const meta = new Map(accounts.map((a: any) => [String(a.Id), a]));
  const warnings: string[] = [];

  const bankAccounts: AccountMove[] = [];
  const moves: AccountMove[] = [];

  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(id)?.value ?? 0;
    const a = after.get(id)?.value ?? 0;
    const change = round2(a - b);
    if (change === 0) continue;
    const acct = meta.get(id);
    const name = acct?.Name || after.get(id)?.name || before.get(id)?.name || `Account ${id}`;
    const type = acct?.AccountType || 'Unknown';
    if (/retained earnings|net income/i.test(name)) continue; // the source side
    const isLiabEq = LIABILITY_OR_EQUITY.has(type);
    const move: AccountMove = {
      id: String(id),
      name,
      acctNum: acct?.AcctNum ?? null,
      type,
      before: b,
      after: a,
      change,
      cashEffect: round2(isLiabEq ? change : -change),
    };
    if (type === 'Bank') bankAccounts.push(move);
    else {
      moves.push(move);
      if (!acct) {
        warnings.push(`Account "${name}" moved ${change} but has no chart-of-accounts entry — treated as an asset.`);
      }
    }
  }

  moves.sort((x, y) => Math.abs(y.cashEffect) - Math.abs(x.cashEffect));
  const bankChange = round2(bankAccounts.reduce((s, m) => s + m.change, 0));
  const totalCashEffect = round2(moves.reduce((s, m) => s + m.cashEffect, 0));

  return { asOfStart, asOfEnd, bankChange, bankAccounts, moves, totalCashEffect, warnings };
}
