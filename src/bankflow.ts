import { QboApi } from './qbo';
import { inventoryPortionOfLines, AccountIds } from './inventorySpend';

// Direct-method bank reconciliation: measure the bank itself instead of
// deriving it from profit. Every inflow and every categorizable outflow over
// the range, so that inflows − outflows ≈ actual bank change, with the gap
// reported honestly as "uncategorized" (QuickBooks' API does not expose
// payroll paychecks or Sales-Tax-Center payments, so those land there).

export interface VendorTotal {
  vendor: string;
  amount: number;
}

export interface BankFlowResult {
  start: string;
  end: string;
  inflows: {
    deposits: number;
    directSalesReceipts: number;
    directInvoicePayments: number;
    transfersIn: number;
    total: number;
  };
  outflows: {
    billPayments: number;
    billPaymentsInventoryPortion: number;
    purchases: number;
    purchasesInventoryPortion: number;
    refundsToCustomers: number;
    transfersToCards: number;
    transfersOutOther: number;
    total: number;
    topVendors: VendorTotal[];
  };
  /** inflows.total − outflows.total */
  netCategorized: number;
  /** Actual bank change from the balance sheet (supplied by caller), if known. */
  actualBankChange: number | null;
  /** actualBankChange − netCategorized: API-invisible flows (payroll, STC tax payments…). */
  uncategorized: number | null;
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function computeBankFlow(
  api: QboApi,
  bankAccountIds: string[],
  inventoryAccountIds: AccountIds,
  startDate: string,
  endDate: string,
  actualBankChange: number | null
): Promise<BankFlowResult> {
  const bankIds = new Set(bankAccountIds);
  const warnings: string[] = [];
  const toBank = (ref: any) => bankIds.has(ref?.value);

  const [deposits, salesReceipts, payments, refundReceipts, purchases, billPayments, transfers] = [
    await api.queryByDateRange('Deposit', startDate, endDate),
    await api.queryByDateRange('SalesReceipt', startDate, endDate),
    await api.queryByDateRange('Payment', startDate, endDate),
    await api.queryByDateRange('RefundReceipt', startDate, endDate),
    await api.queryByDateRange('Purchase', startDate, endDate),
    await api.queryByDateRange('BillPayment', startDate, endDate),
    await api.queryByDateRange('Transfer', startDate, endDate),
  ];

  const totalAmt = (txns: any[]) => txns.reduce((s, t) => s + (Number(t.TotalAmt) || 0), 0);

  // ---- Inflows ----
  const depositsIn = totalAmt(deposits.filter((d) => toBank(d.DepositToAccountRef)));
  const directSr = totalAmt(salesReceipts.filter((t) => toBank(t.DepositToAccountRef)));
  const directPay = totalAmt(payments.filter((t) => toBank(t.DepositToAccountRef)));
  let transfersIn = 0;

  // ---- Outflows ----
  const vendorTotals = new Map<string, number>();
  const addVendor = (name: string, amt: number) => {
    vendorTotals.set(name, (vendorTotals.get(name) || 0) + amt);
  };

  // Bill payments funded by a bank account (checks / ACH). Card-funded bill
  // payments are excluded — that cash leaves when the card gets paid (transfer).
  let bpTotal = 0;
  let bpInventory = 0;
  const billCache = new Map<string, Promise<any>>();
  const getBill = (id: string) => {
    let p = billCache.get(id);
    if (!p) { p = api.getBill(id); billCache.set(id, p); }
    return p;
  };
  for (const bp of billPayments) {
    if (bp.PayType !== 'Check') continue;
    const fundingRef = bp.CheckPayment?.BankAccountRef;
    if (fundingRef && !toBank(fundingRef)) continue; // funded elsewhere
    const amt = Number(bp.TotalAmt) || 0;
    if (amt === 0) continue;
    bpTotal += amt;
    addVendor(bp.VendorRef?.name || 'Unknown vendor', amt);
    for (const line of bp.Line || []) {
      const linked = (line.LinkedTxn || []).find((t: any) => t.TxnType === 'Bill');
      if (!linked) continue;
      const bill = await getBill(linked.TxnId).catch(() => null);
      if (!bill) continue;
      const inv = inventoryPortionOfLines(bill, inventoryAccountIds);
      const charges = (bill.Line || []).reduce(
        (s: number, l: any) => s + Math.max(0, Number(l.Amount) || 0), 0
      );
      if (inv > 0 && charges > 0) {
        bpInventory += (Number(line.Amount) || 0) * (inv / charges);
      }
    }
  }

  // Direct purchases funded by a bank account (checks, debit, cash).
  let purchTotal = 0;
  let purchInventory = 0;
  for (const p of purchases) {
    if (!toBank(p.AccountRef)) continue;
    const sign = p.Credit === true ? -1 : 1;
    const amt = sign * (Number(p.TotalAmt) || 0);
    purchTotal += amt;
    addVendor(p.EntityRef?.name || 'Unknown payee', amt);
    purchInventory += sign * inventoryPortionOfLines(p, inventoryAccountIds);
  }

  // Refunds paid back to customers from a bank account.
  const refundsOut = totalAmt(refundReceipts.filter((t) => toBank(t.DepositToAccountRef)));

  // Transfers: bank→bank is internal (ignored); bank→elsewhere is an outflow
  // (card pay-downs called out separately); elsewhere→bank is an inflow.
  let transfersToCards = 0;
  let transfersOutOther = 0;
  for (const t of transfers) {
    const from = toBank(t.FromAccountRef);
    const to = toBank(t.ToAccountRef);
    const amt = Number(t.Amount) || 0;
    if (from && to) continue;
    if (from) {
      // Heuristic: transfers out of the bank are overwhelmingly card payments.
      transfersToCards += amt;
    } else if (to) {
      transfersIn += amt;
    }
  }
  const inflowsTotal = round2(depositsIn + directSr + directPay + transfersIn);
  const outflowsTotal = round2(bpTotal + purchTotal + refundsOut + transfersToCards + transfersOutOther);
  const netCategorized = round2(inflowsTotal - outflowsTotal);
  const uncategorized = actualBankChange === null ? null : round2(actualBankChange - netCategorized);

  if (uncategorized !== null && Math.abs(uncategorized) > 0.005) {
    warnings.push(
      `$${Math.abs(uncategorized).toFixed(2)} of bank movement is not visible to the QuickBooks API ` +
        `(typically payroll paychecks and Sales-Tax-Center payments${uncategorized > 0 ? ', net inflow' : ', net outflow'}).`
    );
  }

  const topVendors = [...vendorTotals.entries()]
    .map(([vendor, amount]) => ({ vendor, amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 12);

  return {
    start: startDate,
    end: endDate,
    inflows: {
      deposits: round2(depositsIn),
      directSalesReceipts: round2(directSr),
      directInvoicePayments: round2(directPay),
      transfersIn: round2(transfersIn),
      total: inflowsTotal,
    },
    outflows: {
      billPayments: round2(bpTotal),
      billPaymentsInventoryPortion: round2(bpInventory),
      purchases: round2(purchTotal),
      purchasesInventoryPortion: round2(purchInventory),
      refundsToCustomers: round2(refundsOut),
      transfersToCards: round2(transfersToCards),
      transfersOutOther: round2(transfersOutOther),
      total: outflowsTotal,
      topVendors,
    },
    netCategorized,
    actualBankChange,
    uncategorized,
    warnings,
  };
}
