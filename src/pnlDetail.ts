import { QboApi } from './qbo';
import { PnlContext, depositRetailPortion } from './pnl';
import { monthDateRange } from './inventorySpend';

// Transaction-level detail behind each income line of the P&L statement. Uses
// the exact same predicates as computeMonthlyPnl (bank-landed, retail portion,
// offset classification) so every list sums to its statement line; the /checks
// invariants and the on-page sum check verify that it stays true.

export interface DetailRow {
  date: string;
  /** Customer / payee / account label. */
  name: string;
  /** QBO entity type, for deep links into QuickBooks. */
  txnType: string;
  txnId: string | null;
  amount: number;
  detail?: string;
}

export interface PnlDetail {
  start: string;
  end: string;
  deposits: DetailRow[];
  invoicePayments: DetailRow[];
  salesReceipts: DetailRow[];
  refunds: DetailRow[];
  rebates: DetailRow[];
  reimbursements: DetailRow[];
  sums: {
    deposits: number;
    invoicePayments: number;
    salesReceipts: number;
    refunds: number;
    rebates: number;
    reimbursements: number;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const sumOf = (rows: DetailRow[]) => round2(rows.reduce((s, r) => s + r.amount, 0));

export async function computePnlDetail(
  api: QboApi,
  ctx: PnlContext,
  monthOrRange: string | { start: string; end: string },
  accountNames: Map<string, string> = new Map()
): Promise<PnlDetail> {
  const { start, end } =
    typeof monthOrRange === 'string' ? monthDateRange(monthOrRange) : monthOrRange;
  const bankIds = new Set(ctx.bankAccountIds);
  const retailIds = new Set(ctx.retailIncomeAccountIds);
  const toBank = (t: any) => bankIds.has(t.DepositToAccountRef?.value);
  const acctName = (id: any) => accountNames.get(String(id)) || `Account ${id}`;

  const salesReceiptsTxns = await api.queryByDateRange('SalesReceipt', start, end);
  const paymentsTxns = await api.queryByDateRange('Payment', start, end);
  const refundTxns = await api.queryByDateRange('RefundReceipt', start, end);
  const depositTxns = await api.queryByDateRange('Deposit', start, end);

  const deposits: DetailRow[] = [];
  const rebates: DetailRow[] = [];
  const reimbursements: DetailRow[] = [];
  for (const d of depositTxns) {
    if (!toBank(d)) continue; // non-bank deposits are excluded from income (flagged on the statement)
    const portion = depositRetailPortion(d, retailIds);
    if (portion !== 0) {
      const incomeAccounts = [
        ...new Set(
          (d.Line || [])
            .filter((l: any) => retailIds.has(l.DepositLineDetail?.AccountRef?.value))
            .map((l: any) => acctName(l.DepositLineDetail.AccountRef.value))
        ),
      ];
      deposits.push({
        date: d.TxnDate,
        name: incomeAccounts.join(', ') || 'Deposit',
        txnType: 'Deposit',
        txnId: d.Id ? String(d.Id) : null,
        amount: round2(portion),
        detail: d.PrivateNote || undefined,
      });
    }
    if (ctx.accountTypes) {
      for (const line of d.Line || []) {
        const ref = line.DepositLineDetail?.AccountRef?.value;
        if (!ref || retailIds.has(ref)) continue;
        const type = ctx.accountTypes.get(String(ref));
        const amt = Number(line.Amount) || 0;
        const row: DetailRow = {
          date: d.TxnDate,
          name:
            (line.DepositLineDetail?.Entity?.name ? `${line.DepositLineDetail.Entity.name} — ` : '') +
            acctName(ref),
          txnType: 'Deposit',
          txnId: d.Id ? String(d.Id) : null,
          amount: round2(amt),
          detail: line.Description || undefined,
        };
        if (type === 'Cost of Goods Sold') rebates.push(row);
        else if (type === 'Expense' || type === 'Other Expense') reimbursements.push(row);
      }
    }
  }

  const customerRows = (txns: any[], txnType: string): DetailRow[] =>
    txns
      .filter(toBank)
      .map((t) => ({
        date: t.TxnDate,
        name: t.CustomerRef?.name || t.CustomerRef?.value || 'Unknown customer',
        txnType,
        txnId: t.Id ? String(t.Id) : null,
        amount: round2(Number(t.TotalAmt) || 0),
        detail: t.PaymentRefNum ? `Ref ${t.PaymentRefNum}` : undefined,
      }));

  const invoicePayments = customerRows(paymentsTxns, 'Payment');
  const salesReceipts = customerRows(salesReceiptsTxns, 'SalesReceipt');
  const refunds = customerRows(refundTxns, 'RefundReceipt');

  const byDate = (a: DetailRow, b: DetailRow) => a.date.localeCompare(b.date);
  for (const list of [deposits, invoicePayments, salesReceipts, refunds, rebates, reimbursements]) {
    list.sort(byDate);
  }

  return {
    start,
    end,
    deposits,
    invoicePayments,
    salesReceipts,
    refunds,
    rebates,
    reimbursements,
    sums: {
      deposits: sumOf(deposits),
      invoicePayments: sumOf(invoicePayments),
      salesReceipts: sumOf(salesReceipts),
      refunds: sumOf(refunds),
      rebates: sumOf(rebates),
      reimbursements: sumOf(reimbursements),
    },
  };
}

// ---- expense-account transaction detail (from the raw-transaction mirror) ----

/** Signed amounts a single ledger account received across the entity types the
 * API exposes. Payroll and tax-center activity never appears — the caller
 * presents the difference vs the books as an explicit remainder. */
export async function expenseAccountDetail(
  api: QboApi,
  accountId: string,
  start: string,
  end: string
): Promise<{ rows: DetailRow[]; sum: number }> {
  const rows: DetailRow[] = [];
  const id = String(accountId);

  const pushLines = (
    txns: any[],
    txnTypeOf: (t: any) => string,
    lineDetailKey: string,
    nameOf: (t: any) => string,
    signOf: (t: any, line: any) => number
  ) => {
    for (const t of txns) {
      for (const line of t.Line || []) {
        const ref = line[lineDetailKey]?.AccountRef?.value;
        if (String(ref) !== id) continue;
        const sign = signOf(t, line);
        const amt = round2(sign * (Number(line.Amount) || 0));
        if (amt === 0) continue;
        rows.push({
          date: t.TxnDate,
          name: nameOf(t),
          txnType: txnTypeOf(t),
          txnId: t.Id ? String(t.Id) : null,
          amount: amt,
          detail: line.Description || undefined,
        });
      }
    }
  };

  const vendorName = (t: any) =>
    t.VendorRef?.name || t.EntityRef?.name || t.VendorRef?.value || t.EntityRef?.value || 'Unknown payee';

  pushLines(
    await api.queryByDateRange('Bill', start, end),
    () => 'Bill',
    'AccountBasedExpenseLineDetail',
    vendorName,
    () => 1
  );
  pushLines(
    await api.queryByDateRange('Purchase', start, end),
    (t) => (t.PaymentType === 'Check' ? 'Check' : 'Purchase'),
    'AccountBasedExpenseLineDetail',
    vendorName,
    (t) => (t.Credit === true ? -1 : 1)
  );
  pushLines(
    await api.queryByDateRange('VendorCredit', start, end),
    () => 'VendorCredit',
    'AccountBasedExpenseLineDetail',
    vendorName,
    () => -1
  );
  pushLines(
    await api.queryByDateRange('JournalEntry', start, end),
    () => 'JournalEntry',
    'JournalEntryLineDetail',
    (t) => t.PrivateNote || `Journal entry ${t.DocNumber || t.Id}`,
    (_t, line) => (line.JournalEntryLineDetail?.PostingType === 'Credit' ? -1 : 1)
  );
  // Deposit lines coded to an expense account are money back (reimbursements).
  pushLines(
    await api.queryByDateRange('Deposit', start, end),
    () => 'Deposit',
    'DepositLineDetail',
    (t) => t.PrivateNote || 'Deposit (money back)',
    () => -1
  );

  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, sum: sumOf(rows) };
}
