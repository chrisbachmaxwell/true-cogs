import { QboApi } from './qbo';
import { monthDateRange, positiveLineTotal } from './inventorySpend';

// Cash-view income for a month, mirroring the COGS methodology: only actual
// money-movement transactions count (never journal entries), and only the
// portion attributable to the Retail Sales income account(s), e.g. #40100.
//
//   Deposits — deposit lines coded straight to a retail income account (how a
//   POS posts daily sales summaries). The income twin of direct Purchases.
//
//   SalesReceipts — cash collected at the point of sale; the retail portion is
//   the sum of lines whose item maps to a retail income account. Refund
//   receipts subtract the same way.
//
//   Invoice payments — money received against invoices, allocated by each
//   invoice's retail share (retail-item lines ÷ positive line total) — the
//   exact mirror of the BillPayment → Bill inventory ratio.
//
// Deposit lines that pull from Undeposited Funds reference the receipt/payment
// transactions rather than an income account, so nothing is counted twice.

export interface MonthlyPnl {
  month: string;
  startDate: string;
  endDate: string;
  /** Cash attributable to the retail income account(s). */
  retailCashIn: {
    deposits: number;
    salesReceipts: number;
    invoicePayments: number;
    refunds: number;
    total: number;
  };
  /** Reference metric: everything that hit Bank-type accounts. */
  bankInflows: {
    deposits: number;
    directSalesReceipts: number;
    directInvoicePayments: number;
    total: number;
  };
  /** Actual inventory cash spend for the month (both inventory accounts). */
  cogs: number;
  /** retailCashIn.total − cogs */
  grossProfit: number;
  grossMarginPct: number | null;
  /** bankInflows.total − cogs, for the bank-basis view. */
  grossProfitBankBasis: number;
  counts: { salesReceipts: number; invoicePayments: number; refunds: number; deposits: number };
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sum of deposit lines coded directly to the given income accounts. */
export function depositRetailPortion(deposit: any, retailIds: Set<string>): number {
  let sum = 0;
  for (const line of deposit?.Line || []) {
    if (
      line.DetailType === 'DepositLineDetail' &&
      retailIds.has(line.DepositLineDetail?.AccountRef?.value)
    ) {
      sum += Number(line.Amount) || 0;
    }
  }
  return sum;
}

/** Sum of item-based sale lines whose item maps to a retail income account. */
export function itemRetailPortion(
  txn: any,
  retailIds: Set<string>,
  itemIncomeAccount: Map<string, string>
): number {
  let sum = 0;
  for (const line of txn?.Line || []) {
    if (line.DetailType !== 'SalesItemLineDetail') continue;
    const itemId = line.SalesItemLineDetail?.ItemRef?.value;
    const incomeAccount = itemId ? itemIncomeAccount.get(itemId) : undefined;
    if (incomeAccount && retailIds.has(incomeAccount)) {
      sum += Number(line.Amount) || 0;
    }
  }
  return sum;
}

export interface PnlContext {
  bankAccountIds: string[];
  retailIncomeAccountIds: string[];
  /** itemId → income account id (from Item.IncomeAccountRef). */
  itemIncomeAccount: Map<string, string>;
}

export async function computeMonthlyPnl(
  api: QboApi,
  ctx: PnlContext,
  month: string,
  cogs: number
): Promise<MonthlyPnl> {
  const { start, end } = monthDateRange(month);
  const bankIds = new Set(ctx.bankAccountIds);
  const retailIds = new Set(ctx.retailIncomeAccountIds);
  const warnings: string[] = [];

  const salesReceipts = await api.queryByDateRange('SalesReceipt', start, end);
  const payments = await api.queryByDateRange('Payment', start, end);
  const refundReceipts = await api.queryByDateRange('RefundReceipt', start, end);
  const deposits = await api.queryByDateRange('Deposit', start, end);

  const totalAmt = (txns: any[]) => txns.reduce((s, t) => s + (Number(t.TotalAmt) || 0), 0);
  const toBank = (t: any) => bankIds.has(t.DepositToAccountRef?.value);

  // ---- Retail cash in ----
  let depositRetail = 0;
  for (const d of deposits) depositRetail += depositRetailPortion(d, retailIds);

  let srRetail = 0;
  for (const sr of salesReceipts) srRetail += itemRetailPortion(sr, retailIds, ctx.itemIncomeAccount);

  let refundRetail = 0;
  for (const rr of refundReceipts) refundRetail += itemRetailPortion(rr, retailIds, ctx.itemIncomeAccount);

  // Invoice payments: allocate each payment line by the linked invoice's retail
  // share, fetching each invoice once (mirror of the Bill cache in Bucket 1).
  const invoiceCache = new Map<string, Promise<any>>();
  const getInvoice = (id: string) => {
    let p = invoiceCache.get(id);
    if (!p) {
      p = api.getInvoice(id);
      invoiceCache.set(id, p);
    }
    return p;
  };

  let paymentRetail = 0;
  for (const pay of payments) {
    for (const line of pay.Line || []) {
      const linkedInvoice = (line.LinkedTxn || []).find((t: any) => t.TxnType === 'Invoice');
      if (!linkedInvoice) continue;
      const invoice = await getInvoice(linkedInvoice.TxnId);
      const retailPortion = itemRetailPortion(invoice, retailIds, ctx.itemIncomeAccount);
      const chargeTotal = positiveLineTotal(invoice) || Number(invoice?.TotalAmt) || 0;
      if (chargeTotal <= 0 || retailPortion <= 0) continue;
      paymentRetail += (Number(line.Amount) || 0) * (retailPortion / chargeTotal);
    }
  }

  const retailTotal = round2(depositRetail + srRetail + paymentRetail - refundRetail);

  // ---- Bank inflows (reference) ----
  const bankDeposits = totalAmt(deposits.filter(toBank));
  const directSr = totalAmt(salesReceipts.filter(toBank));
  const directPay = totalAmt(payments.filter(toBank));
  const bankTotal = round2(bankDeposits + directSr + directPay);

  const unmappedItems = salesReceipts
    .concat(refundReceipts)
    .flatMap((t) => t.Line || [])
    .filter(
      (l: any) =>
        l.DetailType === 'SalesItemLineDetail' &&
        l.SalesItemLineDetail?.ItemRef?.value &&
        !ctx.itemIncomeAccount.has(l.SalesItemLineDetail.ItemRef.value)
    ).length;
  if (unmappedItems > 0) {
    warnings.push(
      `${unmappedItems} sale line(s) reference items with no income-account mapping — treated as non-retail.`
    );
  }

  return {
    month,
    startDate: start,
    endDate: end,
    retailCashIn: {
      deposits: round2(depositRetail),
      salesReceipts: round2(srRetail),
      invoicePayments: round2(paymentRetail),
      refunds: round2(refundRetail),
      total: retailTotal,
    },
    bankInflows: {
      deposits: round2(bankDeposits),
      directSalesReceipts: round2(directSr),
      directInvoicePayments: round2(directPay),
      total: bankTotal,
    },
    cogs: round2(cogs),
    grossProfit: round2(retailTotal - cogs),
    grossMarginPct: retailTotal > 0 ? round2(((retailTotal - cogs) / retailTotal) * 100) : null,
    grossProfitBankBasis: round2(bankTotal - cogs),
    counts: {
      salesReceipts: salesReceipts.length,
      invoicePayments: payments.length,
      refunds: refundReceipts.length,
      deposits: deposits.length,
    },
    warnings,
  };
}
