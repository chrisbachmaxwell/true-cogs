// The ACH-cleanup reclassify flow — the only write path in the app.
// Chris approved it 2026-07-16 for a one-time, owner-directed cleanup: the
// bank-feed expenses that duplicate ACH-era bill payments get their category
// changed from Material Inventory to the ACH clearing account, so each real
// wire pays down the clearing balance instead of double-counting inventory.
//
// Every candidate is re-validated against the LIVE transaction at execution
// time; anything failing any check is skipped, never written.

export interface ReclassifyConfig {
  /** The account the transaction must be funded from — Zions checking for
   * bank-side tasks, or the card itself for card-side autopay-record tasks. */
  zionsId: string;
  /** The account the matching lines move TO. */
  toId: string;
  toName: string;
  /** Accounts the lines are currently coded to (moved FROM). */
  fromIds: Set<string>;
  /** The from-coded amount the manifest expects on this transaction. */
  expectedAmount: number;
  /** Card-side autopay records are credit-card CREDITS (they reduce the card),
   * so tasks repairing them must opt in; every other task still refuses credits. */
  allowCredit?: boolean;
}

export interface ReclassifyPlan {
  ok: boolean;
  reason: string;
  /** Full purchase object with lines re-pointed at the clearing account. */
  updated?: any;
  /** Sum of the lines that will move. */
  moving?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Validates a live Purchase against the manifest expectations and, when
 * everything checks out, returns the object to write back. Pure function —
 * unit-tested; the endpoint supplies live data and does the I/O. */
export function planReclassify(purchase: any, cfg: ReclassifyConfig): ReclassifyPlan {
  if (!purchase || !purchase.Id) return { ok: false, reason: 'transaction not found' };
  if (purchase.SyncToken === undefined) return { ok: false, reason: 'missing SyncToken' };
  if (String(purchase.AccountRef?.value) !== String(cfg.zionsId)) {
    return { ok: false, reason: `not paid from the expected funding account (paid from account ${purchase.AccountRef?.value})` };
  }
  if (purchase.Credit === true && cfg.allowCredit !== true) return { ok: false, reason: 'is a credit/refund' };

  const lines = (purchase.Line || []).filter(
    (l: any) =>
      l.DetailType === 'AccountBasedExpenseLineDetail' &&
      cfg.fromIds.has(String(l.AccountBasedExpenseLineDetail?.AccountRef?.value))
  );
  const alreadyDone = (purchase.Line || []).some(
    (l: any) =>
      l.DetailType === 'AccountBasedExpenseLineDetail' &&
      String(l.AccountBasedExpenseLineDetail?.AccountRef?.value) === String(cfg.toId)
  );
  if (!lines.length) {
    return alreadyDone
      ? { ok: false, reason: 'already reclassified' }
      : { ok: false, reason: 'no lines coded to the expected source account' };
  }
  const moving = round2(lines.reduce((s: number, l: any) => s + (Number(l.Amount) || 0), 0));
  if (Math.abs(moving - cfg.expectedAmount) > 0.02) {
    return {
      ok: false,
      reason: `inventory lines total $${moving.toFixed(2)} but manifest expects $${cfg.expectedAmount.toFixed(2)} — transaction changed since matching`,
    };
  }
  // Deep-copy, then re-point ONLY the matching lines at the target account.
  const updated = JSON.parse(JSON.stringify(purchase));
  for (const l of updated.Line || []) {
    if (
      l.DetailType === 'AccountBasedExpenseLineDetail' &&
      cfg.fromIds.has(String(l.AccountBasedExpenseLineDetail?.AccountRef?.value))
    ) {
      l.AccountBasedExpenseLineDetail.AccountRef = { value: String(cfg.toId), name: cfg.toName };
    }
  }
  return { ok: true, reason: 'ok', updated, moving };
}

/** Restores a purchase's lines from a saved before-image (revert path). */
export function planRevert(livePurchase: any, beforeImage: any): ReclassifyPlan {
  if (!livePurchase?.Id) return { ok: false, reason: 'transaction not found' };
  if (String(livePurchase.Id) !== String(beforeImage?.Id)) {
    return { ok: false, reason: 'before-image is for a different transaction' };
  }
  const updated = JSON.parse(JSON.stringify(livePurchase));
  updated.Line = JSON.parse(JSON.stringify(beforeImage.Line));
  return { ok: true, reason: 'ok', updated };
}
