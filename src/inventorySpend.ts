import { QboApi } from './qbo';

// Computes "actual cash/credit-card money that left the business for Material
// Inventory" in a month. Two independent buckets:
//
//   Bucket 1 — BillPayments dated in the month, allocated to inventory by each
//   linked Bill's inventory ratio. Payment line amounts are already net of any
//   vendor credit applied at payment time, so VendorCredits are NOT subtracted
//   separately (that would double-count).
//
//   Bucket 2 — direct Purchases (check/cash/credit-card, no Bill) dated in the
//   month, summing lines coded to the inventory account; Credit=true purchases
//   (refunds) subtract.
//
// Bill totals are only ever used to compute the allocation ratio — a Bill is an
// accrual record, not a cash event.

export interface SpendTransaction {
  date: string;
  vendor: string;
  /** 'BillPayment' | 'Purchase' */
  sourceType: string;
  /** Check / CreditCard / Cash */
  paymentMethod: string;
  /** Dollars attributed to Material Inventory (negative = refund/credit-back). */
  amount: number;
  /** Audit trail for Bucket 1 allocations. */
  detail?: string;
  /** QBO transaction id, for deep links into QuickBooks. */
  txnId?: string;
  /** Account the payment was drawn from (bank or credit card), when recorded. */
  fundingAccountId?: string;
}

export interface MonthlySpendResult {
  month: string;
  startDate: string;
  endDate: string;
  /** bucket1Total + bucket2Total — the headline cash number. */
  total: number;
  bucket1Total: number;
  bucket2Total: number;
  /** Accrual view: all Bill + Purchase lines coded to inventory this month, regardless of payment. */
  bookedTotal: number;
  /** Informational only — already reflected in Bucket 1 net payment amounts. */
  vendorCreditsApplied: number;
  transactions: SpendTransaction[];
  /** e.g. JournalEntries/Deposits touching the account outside the Bill/Purchase flow. */
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sum of all positive line amounts (any detail type). Used as the allocation
 * denominator: bills with vendor-discount lines (negative amounts to a discount
 * account) have TotalAmt < sum of charge lines, and dividing by TotalAmt would
 * attribute more cash than was actually paid. Dividing by the positive-line sum
 * spreads the discount pro-rata and keeps attribution ≤ cash paid. */
export function positiveLineTotal(txn: any): number {
  let sum = 0;
  for (const line of txn?.Line || []) {
    const amt = Number(line.Amount) || 0;
    if (amt > 0) sum += amt;
  }
  return sum;
}

/** Accepts one id or several (e.g. Material Inventory #11900 + Boise #11901). */
export type AccountIds = string | string[];

const toIdSet = (ids: AccountIds): Set<string> =>
  new Set(Array.isArray(ids) ? ids : [ids]);

/** Sums Amount over AccountBasedExpenseLineDetail lines coded to the given account(s). */
export function inventoryPortionOfLines(txn: any, accountIds: AccountIds): number {
  const ids = toIdSet(accountIds);
  let sum = 0;
  for (const line of txn?.Line || []) {
    if (
      line.DetailType === 'AccountBasedExpenseLineDetail' &&
      ids.has(line.AccountBasedExpenseLineDetail?.AccountRef?.value)
    ) {
      sum += Number(line.Amount) || 0;
    }
  }
  return sum;
}

export function monthDateRange(month: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month "${month}" — expected YYYY-MM`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new Error(`Invalid month "${month}"`);
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

export async function computeMonthlySpend(
  api: QboApi,
  inventoryAccountIds: AccountIds,
  monthOrRange: string | { start: string; end: string }
): Promise<MonthlySpendResult> {
  const accountIdList = Array.isArray(inventoryAccountIds) ? inventoryAccountIds : [inventoryAccountIds];
  const accountIdSet = new Set(accountIdList);
  const { start, end } =
    typeof monthOrRange === 'string' ? monthDateRange(monthOrRange) : monthOrRange;
  const month = typeof monthOrRange === 'string' ? monthOrRange : `${start}..${end}`;
  const transactions: SpendTransaction[] = [];
  const warnings: string[] = [];

  // Bills are fetched once and cached — several payments can hit the same bill.
  const billCache = new Map<string, Promise<any>>();
  const getBill = (id: string) => {
    let p = billCache.get(id);
    if (!p) {
      p = api.getBill(id);
      billCache.set(id, p);
    }
    return p;
  };

  // ---- Bucket 1: Bills paid via BillPayment ----
  let bucket1Total = 0;
  let vendorCreditsApplied = 0;
  const billPayments = await api.queryByDateRange('BillPayment', start, end);

  for (const bp of billPayments) {
    const payMethod = bp.PayType || 'Unknown';
    const vendor = bp.VendorRef?.name || bp.VendorRef?.value || 'Unknown vendor';
    const fundingAccountId =
      bp.CheckPayment?.BankAccountRef?.value || bp.CreditCardPayment?.CCAccountRef?.value;

    for (const line of bp.Line || []) {
      const linkedTxns: any[] = line.LinkedTxn || [];
      const linkedBill = linkedTxns.find((t) => t.TxnType === 'Bill');
      const linkedCredit = linkedTxns.find((t) => t.TxnType === 'VendorCredit');

      if (linkedCredit) {
        // Context only: this credit already reduced the cash lines, so it is not
        // part of the cash math.
        vendorCreditsApplied += Number(line.Amount) || 0;
        continue;
      }
      if (!linkedBill) continue;

      const bill = await getBill(linkedBill.TxnId);
      const billTotal = Number(bill?.TotalAmt) || 0;
      const inventoryPortionOfBill = inventoryPortionOfLines(bill, accountIdList);
      // Denominator is the sum of the bill's charge (positive) lines, not TotalAmt:
      // with vendor-discount lines, TotalAmt is net of the discount and would
      // yield a ratio > 1, over-attributing beyond the cash that actually left.
      const chargeTotal = positiveLineTotal(bill) || billTotal;
      if (chargeTotal <= 0 || inventoryPortionOfBill <= 0) continue;

      const inventoryRatio = inventoryPortionOfBill / chargeTotal;
      const attributed = round2((Number(line.Amount) || 0) * inventoryRatio);
      if (attributed === 0) continue;

      bucket1Total += attributed;
      console.log(
        `[spend ${month}] BillPayment ${bp.Id} → Bill ${linkedBill.TxnId}: ` +
          `paid ${line.Amount}, bill total ${billTotal}, charges ${chargeTotal}, inventory portion ${inventoryPortionOfBill}, ` +
          `ratio ${inventoryRatio.toFixed(4)}, attributed ${attributed}`
      );
      transactions.push({
        date: bp.TxnDate,
        vendor,
        sourceType: 'BillPayment',
        paymentMethod: payMethod,
        txnId: bp.Id ? String(bp.Id) : undefined,
        fundingAccountId: fundingAccountId ? String(fundingAccountId) : undefined,
        amount: attributed,
        detail:
          `Bill #${bill?.DocNumber || linkedBill.TxnId}: $${inventoryPortionOfBill.toFixed(2)} of ` +
          `$${chargeTotal.toFixed(2)} in charges is inventory (${(inventoryRatio * 100).toFixed(1)}%); ` +
          `payment of $${Number(line.Amount).toFixed(2)} × ratio` +
          (chargeTotal > billTotal ? `; bill net of $${(chargeTotal - billTotal).toFixed(2)} discount` : ''),
      });
    }
  }

  // ---- Bucket 2: direct Purchases ----
  let bucket2Total = 0;
  const purchases = await api.queryByDateRange('Purchase', start, end);
  let purchaseBooked = 0;

  for (const purchase of purchases) {
    const inventoryPortion = inventoryPortionOfLines(purchase, accountIdList);
    if (inventoryPortion <= 0) continue;
    const sign = purchase.Credit === true ? -1 : 1;
    const amount = round2(sign * inventoryPortion);
    bucket2Total += amount;
    purchaseBooked += amount;
    transactions.push({
      date: purchase.TxnDate,
      vendor: purchase.EntityRef?.name || purchase.EntityRef?.value || 'Unknown payee',
      sourceType: 'Purchase',
      paymentMethod: purchase.PaymentType || 'Unknown',
      txnId: purchase.Id ? String(purchase.Id) : undefined,
      fundingAccountId: purchase.AccountRef?.value ? String(purchase.AccountRef.value) : undefined,
      amount,
      detail: purchase.Credit === true ? 'Refund/credit-back (Purchase.Credit=true)' : undefined,
    });
  }

  // ---- Reconciliation: booked (accrual) total ----
  const bills = await api.queryByDateRange('Bill', start, end);
  let billBooked = 0;
  for (const bill of bills) {
    billBooked += inventoryPortionOfLines(bill, accountIdList);
  }
  const bookedTotal = round2(billBooked + purchaseBooked);

  // ---- Out-of-scope flow detection (v1 flags these, doesn't count them) ----
  try {
    const journalEntries = await api.queryByDateRange('JournalEntry', start, end);
    const jeHits = journalEntries.filter((je) =>
      (je.Line || []).some(
        (l: any) => accountIdSet.has(l.JournalEntryLineDetail?.AccountRef?.value)
      )
    );
    if (jeHits.length) {
      warnings.push(
        `${jeHits.length} JournalEntry transaction(s) touch the inventory account this month ` +
          `(ids: ${jeHits.map((j) => j.Id).join(', ')}) — not included in the cash total.`
      );
    }
    const deposits = await api.queryByDateRange('Deposit', start, end);
    const depHits = deposits.filter((d) =>
      (d.Line || []).some(
        (l: any) => accountIdSet.has(l.DepositLineDetail?.AccountRef?.value)
      )
    );
    if (depHits.length) {
      warnings.push(
        `${depHits.length} Deposit transaction(s) touch the inventory account this month ` +
          `(ids: ${depHits.map((d) => d.Id).join(', ')}) — not included in the cash total.`
      );
    }
  } catch (err: any) {
    console.warn(`[spend ${month}] out-of-scope flow check failed: ${err.message}`);
  }

  transactions.sort((a, b) => a.date.localeCompare(b.date));

  return {
    month,
    startDate: start,
    endDate: end,
    total: round2(bucket1Total + bucket2Total),
    bucket1Total: round2(bucket1Total),
    bucket2Total: round2(bucket2Total),
    bookedTotal,
    vendorCreditsApplied: round2(vendorCreditsApplied),
    transactions,
    warnings,
  };
}
