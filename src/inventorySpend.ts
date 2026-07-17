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
  /** Inventory RECEIVED this month: Bill + direct Purchase lines coded to
   * inventory, net of vendor-credit returns — regardless of when paid. This is
   * the "purchases" the begin+purchases−end COGS formula wants. */
  bookedTotal: number;
  /** bookedTotal components, for the drill-down and cross-checks. */
  billedTotal: number;
  directBoughtTotal: number;
  vendorCreditBooked: number;
  /** Informational only — already reflected in Bucket 1 net payment amounts. */
  vendorCreditsApplied: number;
  /** Spend skipped because it was drawn from an excluded pseudo-bank account. */
  excludedFundingTotal: number;
  transactions: SpendTransaction[];
  /** e.g. JournalEntries/Deposits touching the account outside the Bill/Purchase flow. */
  warnings: string[];
}

/** Payments drawn from these accounts are left out of the cash math — used for
 * unreconciled clearing accounts whose entries duplicate real bank payments. */
export interface SpendOptions {
  excludeFundingAccounts?: { ids: Set<string>; label: string };
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
  monthOrRange: string | { start: string; end: string },
  opts: SpendOptions = {}
): Promise<MonthlySpendResult> {
  const excludedIds = opts.excludeFundingAccounts?.ids;
  let excludedFundingTotal = 0;
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

    // QBO records each bill-linked line at the bill's FULL covered amount —
    // cash and applied credits BLENDED — with the credits as separate
    // context lines. Counting line amounts as cash overstated spend by the
    // credits (~$1.2–1.5M/yr; found 2026-07-17, the bug behind every
    // "P&L runs $1M below Chris's gut" symptom). Scale every bill line by
    // the payment's cash fraction so only money that actually left counts:
    // Chris's rule — "I only want to count what we paid for the bill."
    let billLinesTotal = 0;
    let creditLinesTotal = 0;
    for (const line of bp.Line || []) {
      const linked: any[] = line.LinkedTxn || [];
      if (linked.some((t) => t.TxnType === 'VendorCredit')) creditLinesTotal += Number(line.Amount) || 0;
      else if (linked.some((t) => t.TxnType === 'Bill')) billLinesTotal += Number(line.Amount) || 0;
    }
    // TotalAmt is the actual cash and is authoritative when present; the
    // line identity (bill coverage − credits = cash) is the fallback.
    const paymentCash = bp.TotalAmt !== undefined && bp.TotalAmt !== null
      ? Number(bp.TotalAmt) || 0
      : Math.max(billLinesTotal - creditLinesTotal, 0);
    const cashFraction = billLinesTotal > 0 ? Math.max(0, Math.min(paymentCash / billLinesTotal, 1)) : 1;

    for (const line of bp.Line || []) {
      const linkedTxns: any[] = line.LinkedTxn || [];
      const linkedBill = linkedTxns.find((t) => t.TxnType === 'Bill');
      const linkedCredit = linkedTxns.find((t) => t.TxnType === 'VendorCredit');

      if (linkedCredit) {
        // Context only: the cash-fraction scaling above keeps these out of
        // the cash math.
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
      const attributed = round2((Number(line.Amount) || 0) * cashFraction * inventoryRatio);
      if (attributed === 0) continue;

      if (excludedIds && fundingAccountId && excludedIds.has(String(fundingAccountId))) {
        excludedFundingTotal += attributed;
        continue;
      }
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
          `covered $${Number(line.Amount).toFixed(2)}` +
          (cashFraction < 0.9999 ? `, cash share ${(cashFraction * 100).toFixed(1)}% (rest by credits)` : '') +
          ` × ratio` +
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
    if (excludedIds && purchase.AccountRef?.value && excludedIds.has(String(purchase.AccountRef.value))) {
      excludedFundingTotal += amount;
      continue;
    }
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

  // ---- Inventory received (the accounting-basis "purchases") ----
  const bills = await api.queryByDateRange('Bill', start, end);
  let billBooked = 0;
  for (const bill of bills) {
    billBooked += inventoryPortionOfLines(bill, accountIdList);
  }
  // Vendor credits (returns / credit memos from vendors) reduce inventory
  // received in the period they're issued.
  let vendorCreditBooked = 0;
  for (const vc of await api.queryByDateRange('VendorCredit', start, end)) {
    vendorCreditBooked += inventoryPortionOfLines(vc, accountIdList);
  }
  const bookedTotal = round2(billBooked + purchaseBooked - vendorCreditBooked);

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

  if (excludedFundingTotal !== 0 && opts.excludeFundingAccounts) {
    warnings.push(
      `Excluded $${round2(excludedFundingTotal).toFixed(2)} of payments recorded from ` +
        `${opts.excludeFundingAccounts.label} — an unreconciled clearing account whose entries ` +
        `duplicate real bank payments. Remove QBO_EXCLUDED_FUNDING_ACCOUNTS once the books are repaired.`
    );
  }

  return {
    month,
    startDate: start,
    endDate: end,
    total: round2(bucket1Total + bucket2Total),
    bucket1Total: round2(bucket1Total),
    bucket2Total: round2(bucket2Total),
    bookedTotal,
    billedTotal: round2(billBooked),
    directBoughtTotal: round2(purchaseBooked),
    vendorCreditBooked: round2(vendorCreditBooked),
    vendorCreditsApplied: round2(vendorCreditsApplied),
    excludedFundingTotal: round2(excludedFundingTotal),
    transactions,
    warnings,
  };
}

// ---- Purchases as settled: what we actually paid for each bill ----
// Chris's rule (2026-07-17): "I only want to count what we paid for the bill."
// A bill's true cost is its cash settlement — vendor credits (rebates, returns,
// pass-throughs) are the part of the bill that was never ours to pay. Booked on
// the BILL's date, so payment timing never moves profit between periods.
//
// Per bill: cost = cash applied so far + remaining balance (QBO keeps Balance
// current). For a fully settled bill that is exactly the cash paid (verified:
// cash + credits = bill totals within 0.2% across 467 payments); for an open
// bill it assumes the remainder will be paid in cash and self-corrects as
// credits land. Direct no-bill purchases count as before, at their own dates.

export interface PurchasesSettledResult {
  total: number;
  billedNet: number;
  directTotal: number;
  creditsNetted: number;
  openBillCount: number;
  openBillExpected: number;
  transactions: SpendTransaction[];
}

export async function computePurchasesSettled(
  api: QboApi,
  inventoryAccountIds: AccountIds,
  range: { start: string; end: string },
  today: string
): Promise<PurchasesSettledResult> {
  const accountIdList = Array.isArray(inventoryAccountIds) ? inventoryAccountIds : [inventoryAccountIds];
  const transactions: SpendTransaction[] = [];

  // Cash applied per bill, from every payment dated bill-period start → today.
  const cashByBill = new Map<string, number>();
  for (const bp of await api.queryByDateRange('BillPayment', range.start, today)) {
    for (const line of bp.Line || []) {
      // A credit-application line links BOTH the VendorCredit and the Bill it
      // pays down — that's credit coverage, not cash. Same precedence as bucket 1.
      if ((line.LinkedTxn || []).some((t: any) => t.TxnType === 'VendorCredit')) continue;
      const linked = (line.LinkedTxn || []).find((t: any) => t.TxnType === 'Bill');
      if (!linked) continue;
      cashByBill.set(String(linked.TxnId), (cashByBill.get(String(linked.TxnId)) || 0) + (Number(line.Amount) || 0));
    }
  }

  let billedNet = 0;
  let creditsNetted = 0;
  let openBillCount = 0;
  let openBillExpected = 0;
  for (const bill of await api.queryByDateRange('Bill', range.start, range.end)) {
    const inventoryPortion = inventoryPortionOfLines(bill, accountIdList);
    if (inventoryPortion <= 0) continue;
    const billTotal = Number(bill.TotalAmt) || 0;
    const chargeTotal = positiveLineTotal(bill) || billTotal;
    if (chargeTotal <= 0) continue;
    const balance = Number(bill.Balance) || 0;
    const cashSoFar = cashByBill.get(String(bill.Id)) || 0;
    const expectedCash = round2(cashSoFar + balance);
    const credits = round2(billTotal - expectedCash);
    const cost = round2(expectedCash * (inventoryPortion / chargeTotal));
    if (cost === 0) continue;
    billedNet += cost;
    creditsNetted += round2(credits * (inventoryPortion / chargeTotal));
    if (balance > 0.01) {
      openBillCount++;
      openBillExpected += round2(balance * (inventoryPortion / chargeTotal));
    }
    transactions.push({
      date: bill.TxnDate,
      vendor: bill.VendorRef?.name || bill.VendorRef?.value || 'Unknown vendor',
      sourceType: 'BillPayment',
      paymentMethod: 'Bill',
      txnId: bill.Id ? String(bill.Id) : undefined,
      amount: cost,
      detail:
        `Bill #${bill.DocNumber || bill.Id}: $${billTotal.toFixed(2)} billed` +
        (credits > 0.01 ? ` − $${credits.toFixed(2)} covered by credits` : '') +
        (balance > 0.01 ? ` ($${balance.toFixed(2)} still open, assumed cash)` : ''),
    });
  }

  let directTotal = 0;
  for (const purchase of await api.queryByDateRange('Purchase', range.start, range.end)) {
    const portion = inventoryPortionOfLines(purchase, accountIdList);
    if (portion <= 0) continue;
    const amount = round2((purchase.Credit === true ? -1 : 1) * portion);
    directTotal += amount;
    transactions.push({
      date: purchase.TxnDate,
      vendor: purchase.EntityRef?.name || purchase.EntityRef?.value || 'Unknown payee',
      sourceType: 'Purchase',
      paymentMethod: purchase.PaymentType || 'Unknown',
      txnId: purchase.Id ? String(purchase.Id) : undefined,
      amount,
      detail: purchase.Credit === true ? 'Refund/credit-back' : 'Direct buy (no bill)',
    });
  }

  transactions.sort((a, b) => a.date.localeCompare(b.date));
  return {
    total: round2(billedNet + directTotal),
    billedNet: round2(billedNet),
    directTotal: round2(directTotal),
    creditsNetted: round2(creditsNetted),
    openBillCount,
    openBillExpected: round2(openBillExpected),
    transactions,
  };
}
