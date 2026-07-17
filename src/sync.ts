import { getPool, getConfigValue, setConfigValue } from './db';
import { QboApi, EntityName, createQboApi } from './qbo';
import { config } from './config';

// Raw-transaction sync: QuickBooks data is mirrored into Postgres (qbo_txns)
// so recomputations read locally in milliseconds instead of re-fetching at the
// API rate limit. A full sync backfills the window; incremental syncs pull only
// entities whose MetaData.LastUpdatedTime changed since the last run.
//
// Known limitation: hard-deleted transactions are not detected incrementally
// (QBO's change-data-capture is needed for that); a periodic full sync of the
// recent window trues things up.

export const SYNCED_ENTITIES: EntityName[] = [
  'Deposit',
  'Payment',
  'SalesReceipt',
  'RefundReceipt',
  'BillPayment',
  'Bill',
  'Purchase',
  'VendorCredit',
  'Transfer',
  'JournalEntry',
  'CreditCardPayment',
];

const LAST_SYNC_KEY = 'last_sync_at';
const SYNC_START = process.env.QBO_SYNC_START || '2025-07-01';

export interface SyncStatus {
  running: boolean;
  lastSyncAt: string | null;
  lastResult: string | null;
}

let running = false;
let lastResult: string | null = null;

export async function syncStatus(): Promise<SyncStatus> {
  return { running, lastSyncAt: await getConfigValue(LAST_SYNC_KEY), lastResult };
}

export async function upsertTxns(entity: string, txns: any[]): Promise<number> {
  const db = getPool();
  let n = 0;
  for (const t of txns) {
    if (!t?.Id) continue;
    await db.query(
      `INSERT INTO qbo_txns (entity_type, id, txn_date, last_updated, data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (entity_type, id)
       DO UPDATE SET txn_date = EXCLUDED.txn_date, last_updated = EXCLUDED.last_updated, data = EXCLUDED.data`,
      [entity, String(t.Id), t.TxnDate || null, t.MetaData?.LastUpdatedTime || null, JSON.stringify(t)]
    );
    n++;
  }
  return n;
}

async function syncAccounts(api: QboApi): Promise<number> {
  const accounts = await api.listAccounts();
  const db = getPool();
  for (const a of accounts) {
    await db.query(
      `INSERT INTO qbo_txns (entity_type, id, txn_date, last_updated, data)
       VALUES ('Account', $1, NULL, $2, $3)
       ON CONFLICT (entity_type, id)
       DO UPDATE SET last_updated = EXCLUDED.last_updated, data = EXCLUDED.data`,
      [String(a.Id), a.MetaData?.LastUpdatedTime || null, JSON.stringify(a)]
    );
  }
  return accounts.length;
}

/** Runs a sync. Full = re-pull the whole window; otherwise only entities
 * changed since the last sync (with a 1h overlap for clock skew). */
/** Registered by the server: recomputes commonly viewed statements after a
 * sync lands, so users hit warm caches instead of the cold path. */
let onSyncComplete: (() => void) | null = null;
export function setOnSyncComplete(fn: () => void): void {
  onSyncComplete = fn;
}

export async function runSync(full: boolean): Promise<string> {
  if (running) return 'already running';
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const api = await createQboApi();
    const lastSync = await getConfigValue(LAST_SYNC_KEY);
    const doFull = full || !lastSync;
    const counts: string[] = [];
    const today = new Date().toISOString().slice(0, 10);

    for (const entity of SYNCED_ENTITIES) {
      let txns: any[];
      if (doFull) {
        txns = await api.queryByDateRange(entity, SYNC_START, today);
      } else {
        const since = new Date(new Date(lastSync!).getTime() - 60 * 60 * 1000).toISOString();
        txns = await api.queryChangedSince!(entity, since);
      }
      const n = await upsertTxns(entity, txns);
      // Hard deletes leave no trace for incremental sync; a full pull is the
      // complete truth for the window, so purge mirror rows QBO no longer has
      // (otherwise deleted transactions keep counting — bit us during the ACH
      // cleanup when deleted feed expenses lingered in the mirror).
      if (doFull) {
        const freshIds = txns.map((t) => String(t.Id));
        const res = await getPool().query(
          `DELETE FROM qbo_txns
           WHERE entity_type = $1 AND txn_date >= $2 AND txn_date <= $3
             AND NOT (id = ANY($4))`,
          [entity, SYNC_START, today, freshIds]
        );
        if (res.rowCount) counts.push(`${entity}-purged:${res.rowCount}`);
      }
      counts.push(`${entity}:${n}`);
    }
    counts.push(`Account:${await syncAccounts(api)}`);
    await setConfigValue(LAST_SYNC_KEY, startedAt);
    lastResult = `${doFull ? 'full' : 'incremental'} sync ok @ ${startedAt} — ${counts.join(' ')}`;
    console.log(`[sync] ${lastResult}`);
    // Re-warm the report caches the sync may have just invalidated, so the
    // next page load never pays the cold-compute cost.
    if (onSyncComplete) setTimeout(() => onSyncComplete!(), 0);
    return lastResult;
  } catch (err: any) {
    lastResult = `sync failed @ ${startedAt}: ${err.message}`;
    console.error(`[sync] ${lastResult}`);
    return lastResult;
  } finally {
    running = false;
  }
}

const STALE_MS = 26 * 60 * 60 * 1000;

export async function isStoreFresh(): Promise<boolean> {
  const last = await getConfigValue(LAST_SYNC_KEY);
  return Boolean(last && Date.now() - new Date(last).getTime() < STALE_MS);
}

/** Kicks an incremental sync if the store is stale. Fire-and-forget safe. */
export async function syncIfStale(): Promise<void> {
  if (!(await isStoreFresh()) && !running) {
    runSync(false).catch((err) => console.error('[sync] background sync failed:', err.message));
  }
}

/** A QboApi that reads transactions and accounts from the local mirror,
 * delegating to the remote API for anything not stored (reports, missing
 * bills — which are also backfilled into the store on fetch). */
export function makeLocalApi(remote: QboApi): QboApi {
  const db = getPool();
  return {
    async queryByDateRange(entity, start, end) {
      const res = await db.query(
        `SELECT data FROM qbo_txns WHERE entity_type = $1 AND txn_date >= $2 AND txn_date <= $3`,
        [entity, start, end]
      );
      return res.rows.map((r) => r.data);
    },
    queryChangedSince: remote.queryChangedSince?.bind(remote),
    async getBill(id: string) {
      const res = await db.query(`SELECT data FROM qbo_txns WHERE entity_type = 'Bill' AND id = $1`, [id]);
      if (res.rows.length) return res.rows[0].data;
      const bill = await remote.getBill(id);
      await upsertTxns('Bill', [bill]);
      return bill;
    },
    async getBills(ids: string[]) {
      if (!ids.length) return [];
      const res = await db.query(`SELECT data FROM qbo_txns WHERE entity_type = 'Bill' AND id = ANY($1)`, [ids.map(String)]);
      const found = res.rows.map((r) => r.data);
      const have = new Set(found.map((b: any) => String(b.Id)));
      for (const id of ids) {
        if (have.has(String(id))) continue;
        try {
          const bill = await remote.getBill(String(id));
          await upsertTxns('Bill', [bill]);
          found.push(bill);
        } catch { /* deleted or unreachable — caller treats as missing */ }
      }
      return found;
    },
    getInvoice: (id) => remote.getInvoice(id),
    async getPurchase(id: string) {
      const res = await db.query(`SELECT data FROM qbo_txns WHERE entity_type = 'Purchase' AND id = $1`, [id]);
      if (res.rows.length) return res.rows[0].data;
      if (!remote.getPurchase) throw new Error('Purchase not found in mirror');
      return remote.getPurchase(id);
    },
    async listAccounts() {
      const res = await db.query(`SELECT data FROM qbo_txns WHERE entity_type = 'Account'`);
      if (res.rows.length) return res.rows.map((r) => r.data);
      return remote.listAccounts();
    },
    listItems: () => remote.listItems(),
    balanceSheet: (asOf) => remote.balanceSheet(asOf),
    profitAndLoss: (s, e) => remote.profitAndLoss(s, e),
  };
}

/** True if any mirrored transaction dated inside [start, end] has been edited
 * in QuickBooks since `computedAt` — used to auto-invalidate cached results
 * when Chris recategorizes history. (Edits that MOVE a transaction out of the
 * range or hard-delete it are invisible to this check; the Refresh button and
 * full syncs remain the backstop for those.) */
export async function mirrorChangedSince(start: string, end: string, computedAt: Date): Promise<boolean> {
  try {
    const r = await getPool().query(
      `SELECT max(last_updated) AS m FROM qbo_txns WHERE txn_date BETWEEN $1 AND $2`,
      [start, end]
    );
    const m = r.rows[0]?.m;
    return m !== null && m !== undefined && new Date(m) > computedAt;
  } catch {
    return false; // if the mirror is unreachable the cache is the best we have
  }
}
