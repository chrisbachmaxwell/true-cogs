export interface AppConfig {
  port: number;
  qboClientId: string | undefined;
  qboClientSecret: string | undefined;
  qboEnvironment: 'sandbox' | 'production';
  qboRedirectUri: string | undefined;
  tokenEncryptionKey: string | undefined;
  databaseUrl: string | undefined;
  /** Chart-of-accounts entries whose spend we track — each token matches an
   * account number (AcctNum) or exact account name, case-insensitive. */
  inventoryAccounts: string[];
  /** Income accounts counted as retail sales for the cash P&L (same matching). */
  retailIncomeAccounts: string[];
  /** Direct-cost accounts (freight, customer repairs, materials) whose cash
   * payments are added to COGS. */
  directCostAccounts: string[];
  /** Sales-tax liability account(s): remittances to them are deducted from
   * revenue, because the POS sync books tax-inclusive amounts into income. */
  salesTaxAccounts: string[];
  /** Seeds the first admin when the users table is empty. Auth is enforced
   * whenever at least one user exists. */
  adminEmail: string | undefined;
  adminInitialPassword: string | undefined;
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  qboClientId: process.env.QBO_CLIENT_ID,
  qboClientSecret: process.env.QBO_CLIENT_SECRET,
  qboEnvironment:
    (process.env.QBO_ENVIRONMENT || 'sandbox') === 'production' ? 'production' : 'sandbox',
  qboRedirectUri: process.env.QBO_REDIRECT_URI,
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  databaseUrl: process.env.DATABASE_URL,
  inventoryAccounts: (process.env.QBO_INVENTORY_ACCOUNTS ||
    process.env.QBO_INVENTORY_ACCOUNT_NAME ||
    'Material Inventory')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  retailIncomeAccounts: (process.env.QBO_RETAIL_INCOME_ACCOUNTS || '40100')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  directCostAccounts: (process.env.QBO_DIRECT_COST_ACCOUNTS || '51300,50600,50200')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  salesTaxAccounts: (process.env.QBO_SALES_TAX_ACCOUNTS || '21900')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  adminEmail: process.env.ADMIN_EMAIL || 'chrism@pictureline.com',
  adminInitialPassword: process.env.ADMIN_INITIAL_PASSWORD,
};

/** Missing env vars are reported per-feature instead of crashing the whole app,
 * so an empty shell can be deployed to Railway before credentials exist. */
export function missingQboConfig(): string[] {
  const missing: string[] = [];
  if (!config.qboClientId) missing.push('QBO_CLIENT_ID');
  if (!config.qboClientSecret) missing.push('QBO_CLIENT_SECRET');
  if (!config.qboRedirectUri) missing.push('QBO_REDIRECT_URI');
  if (!config.tokenEncryptionKey) missing.push('TOKEN_ENCRYPTION_KEY');
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  return missing;
}
