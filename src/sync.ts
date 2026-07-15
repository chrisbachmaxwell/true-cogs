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

async function upsertTxns(entity: string, txns: any[]): Promise<number> {
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
      counts.push(`${entity}:${n}`);
    }
    counts.push(`Account:${await syncAccounts(api)}`);
    await setConfigValue(LAST_SYNC_KEY, startedAt);
    lastResult = `${doFull ? 'full' : 'incremental'} sync ok @ ${startedAt} — ${counts.join(' ')}`;
    console.log(`[sync] ${lastResult}`);
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
    getInvoice: (id) => remote.getInvoice(id),
    async listAccounts() {
      const res = await db.query(`SELECT data FROM qbo_txns WHERE entity_type = 'Account'`);
      if (res.rows.length) return res.rows.map((r) => r.data);
      return remote.listAccounts();
    },
    listItems: () => remote.listItems(),
    balanceSheet: (asOf) => remote.balanceSheet(asOf),
  };
}
