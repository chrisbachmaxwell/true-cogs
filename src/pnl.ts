import { QboApi } from './qbo';
import { monthDateRange } from './inventorySpend';

// Cash-view income for a month, measured two ways — both built only from real
// money-movement transactions (never journal entries):
//
//   Customer money in — SalesReceipts (paid at point of sale) plus Payments
//   (received against invoices), minus RefundReceipts (money returned). Counted
//   on the day the customer paid, regardless of when it reached the bank.
//
//   Bank inflows — money that actually hit a Bank-type account this month:
//   Deposit transactions into bank accounts (undeposited-funds batches, merchant
//   payouts, any directly recorded deposit) plus SalesReceipts/Payments recorded
//   straight to a bank account (skipping Undeposited Funds).
//
// The two differ by settlement timing (a card sale on the 30th lands in the
// bank in the next month) and by non-sales deposits (loan proceeds, transfers
// recorded as deposits). Transfers between own accounts (Transfer entity) are
// excluded from both.

export interface MonthlyPnl {
  month: string;
  startDate: string;
  endDate: string;
  customerMoneyIn: {
    salesReceipts: number;
    invoicePayments: number;
    refunds: number;
    total: number;
  };
  bankInflows: {
    deposits: number;
    directSalesReceipts: number;
    directInvoicePayments: number;
    total: number;
  };
  /** Actual inventory cash spend for the month (both inventory accounts). */
  cogs: number;
  /** customerMoneyIn.total − cogs */
  grossProfit: number;
  grossMarginPct: number | null;
  /** bankInflows.total − cogs, for the bank-basis view. */
  grossProfitBankBasis: number;
  counts: { salesReceipts: number; invoicePayments: number; refunds: number; deposits: number };
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function computeMonthlyPnl(
  api: QboApi,
  bankAccountIds: string[],
  month: string,
  cogs: number
): Promise<MonthlyPnl> {
  const { start, end } = monthDateRange(month);
  const bankIds = new Set(bankAccountIds);
  const warnings: string[] = [];

  const [salesReceipts, payments, refundReceipts, deposits] = [
    await api.queryByDateRange('SalesReceipt', start, end),
    await api.queryByDateRange('Payment', start, end),
    await api.queryByDateRange('RefundReceipt', start, end),
    await api.queryByDateRange('Deposit', start, end),
  ];

  const total = (txns: any[]) => txns.reduce((s, t) => s + (Number(t.TotalAmt) || 0), 0);
  const toBank = (t: any) => bankIds.has(t.DepositToAccountRef?.value);

  const srTotal = total(salesReceipts);
  const payTotal = total(payments);
  const refundTotal = total(refundReceipts);

  const bankDeposits = total(deposits.filter(toBank));
  const directSr = total(salesReceipts.filter(toBank));
  const directPay = total(payments.filter(toBank));

  const nonBankDeposits = deposits.filter((d) => !toBank(d));
  if (nonBankDeposits.length) {
    warnings.push(
      `${nonBankDeposits.length} Deposit(s) went to non-bank accounts this month — excluded from bank inflows.`
    );
  }

  const customerTotal = round2(srTotal + payTotal - refundTotal);
  const bankTotal = round2(bankDeposits + directSr + directPay);

  return {
    month,
    startDate: start,
    endDate: end,
    customerMoneyIn: {
      salesReceipts: round2(srTotal),
      invoicePayments: round2(payTotal),
      refunds: round2(refundTotal),
      total: customerTotal,
    },
    bankInflows: {
      deposits: round2(bankDeposits),
      directSalesReceipts: round2(directSr),
      directInvoicePayments: round2(directPay),
      total: bankTotal,
    },
    cogs: round2(cogs),
    grossProfit: round2(customerTotal - cogs),
    grossMarginPct: customerTotal > 0 ? round2(((customerTotal - cogs) / customerTotal) * 100) : null,
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
