import { QboApi } from './qbo';
import { monthDateRange } from './inventorySpend';

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
  /** Cash paid to direct-cost accounts (freight, customer repairs, materials).
   * Added to COGS in the gross-profit math. */
  directCosts: number;
  /** Deposited money-back from vendors, coded to COGS-type accounts (refunds,
   * rebates). Reduces COGS in the gross-profit math. */
  cogsOffsets: number;
  /** Deposited reimbursements coded to Expense-type accounts (ad co-op etc.).
   * Reduces operating expenses when computing NOI. */
  expenseOffsets: number;
  /** Sales tax remitted this month — deducted from revenue because the POS
   * sync books tax-inclusive amounts into the income accounts. */
  salesTaxRemitted: number;
  /** retailCashIn.total − salesTaxRemitted: revenue that is actually yours. */
  revenueNet: number;
  /** Actual inventory cash spend for the month (both inventory accounts). */
  cogs: number;
  /** revenueNet − cogs */
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
  /** accountId → AccountType, for classifying non-income deposit lines. */
  accountTypes?: Map<string, string>;
}

export async function computeMonthlyPnl(
  api: QboApi,
  ctx: PnlContext,
  month: string,
  cogs: number,
  salesTaxRemitted = 0,
  directCosts = 0
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
  // Income lines only count when the deposit actually landed in a Bank-type
  // account — a deposit routed elsewhere never increased the bank. Deposited
  // money-back coded to COGS/Expense accounts (vendor rebates, ad co-op) is
  // captured as cost offsets rather than revenue.
  let depositRetail = 0;
  let nonBankIncomeDeposits = 0;
  let cogsOffsets = 0;
  let expenseOffsets = 0;
  for (const d of deposits) {
    const portion = depositRetailPortion(d, retailIds);
    if (portion !== 0) {
      if (toBank(d)) depositRetail += portion;
      else nonBankIncomeDeposits += portion;
    }
    if (toBank(d) && ctx.accountTypes) {
      for (const line of d.Line || []) {
        const ref = line.DepositLineDetail?.AccountRef?.value;
        if (!ref || retailIds.has(ref)) continue;
        const type = ctx.accountTypes.get(String(ref));
        const amt = Number(line.Amount) || 0;
        if (type === 'Cost of Goods Sold') cogsOffsets += amt;
        else if (type === 'Expense' || type === 'Other Expense') expenseOffsets += amt;
      }
    }
  }
  if (nonBankIncomeDeposits > 0) {
    warnings.push(
      `$${nonBankIncomeDeposits.toFixed(2)} of income-coded deposit lines went to non-bank accounts — excluded from income.`
    );
  }

  // Customer money in counts at full, tax-inclusive value — the same convention
  // the POS deposits carry — so sales tax is deducted exactly once, via the
  // remittance line. Costs of every invoiced element (shipping, fees) sit in
  // expenses, so their revenue counts too. BUT only when the cash actually
  // landed in a bank account: payments settled into non-bank accounts (e.g.
  // store-credit via a Credit Memos asset account) moved no money.
  const bankLanded = (txns: any[]) => txns.filter((t) => toBank(t));
  const srRetail = totalAmt(bankLanded(salesReceipts));
  const refundRetail = totalAmt(bankLanded(refundReceipts));
  const paymentRetail = totalAmt(bankLanded(payments));
  const nonBankCustomerCash = round2(
    totalAmt(payments) + totalAmt(salesReceipts) - paymentRetail - srRetail
  );
  if (nonBankCustomerCash > 0) {
    warnings.push(
      `$${nonBankCustomerCash.toFixed(2)} of customer payments/receipts settled into non-bank accounts (store credit etc.) — no cash moved, excluded from income.`
    );
  }

  const retailTotal = round2(depositRetail + srRetail + paymentRetail - refundRetail);

  // ---- Bank inflows (reference) ----
  const bankDeposits = totalAmt(deposits.filter(toBank));
  const directSr = totalAmt(salesReceipts.filter(toBank));
  const directPay = totalAmt(payments.filter(toBank));
  const bankTotal = round2(bankDeposits + directSr + directPay);

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
    directCosts: round2(directCosts),
    cogsOffsets: round2(cogsOffsets),
    expenseOffsets: round2(expenseOffsets),
    salesTaxRemitted: round2(salesTaxRemitted),
    revenueNet: round2(retailTotal - salesTaxRemitted),
    cogs: round2(cogs),
    grossProfit: round2(retailTotal - salesTaxRemitted - cogs - directCosts + cogsOffsets),
    grossMarginPct:
      retailTotal - salesTaxRemitted > 0
        ? round2(
            ((retailTotal - salesTaxRemitted - cogs - directCosts + cogsOffsets) /
              (retailTotal - salesTaxRemitted)) * 100
          )
        : null,
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
