// Resolves the Postgres connection string for the app and for migrations.
//
// DATABASE_URL wins when set. Otherwise it falls back to the variables the
// Supabase integration on Vercel injects (DATABASE_POSTGRES_* with the
// "DATABASE" prefix, or the default POSTGRES_* names).
//
// Runtime uses Supabase's transaction pooler (port 6543). Migrations need a
// session connection (advisory locks), so they use the same pooler host on the
// session port (5432), which also stays reachable over IPv4.

const SUPABASE_HOST = /supabase\.(com|co)\b/;

function pick(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function setParam(url: string, key: string, value: string | null): string {
  const pattern = new RegExp(`([?&])${key}=[^&]*&?`);
  let next = url.replace(pattern, "$1").replace(/[?&]$/, "");
  if (value !== null) {
    next += `${next.includes("?") ? "&" : "?"}${key}=${value}`;
  }
  return next;
}

/** Connection string for the running app (node-postgres via @prisma/adapter-pg). */
export function resolveRuntimeDatabaseUrl(): string | undefined {
  const raw = pick("DATABASE_URL", "DATABASE_POSTGRES_URL", "POSTGRES_URL");
  if (!raw || !SUPABASE_HOST.test(raw)) return raw;
  // node-postgres treats sslmode=require as verify-full, and Supabase's pooler
  // certificate isn't in Node's trust store. Keep TLS, skip CA verification.
  let url = setParam(raw, "supa", null);
  url = setParam(url, "pgbouncer", null);
  return setParam(url, "sslmode", "no-verify");
}

/** Connection string for `prisma migrate` (needs a session, not a transaction pooler). */
export function resolveMigrationDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const pooled = pick("DATABASE_POSTGRES_URL", "POSTGRES_URL");
  if (!pooled) return pick("DATABASE_POSTGRES_URL_NON_POOLING", "POSTGRES_URL_NON_POOLING");
  if (!SUPABASE_HOST.test(pooled)) return pooled;
  let url = pooled.replace(":6543/", ":5432/");
  url = setParam(url, "supa", null);
  url = setParam(url, "pgbouncer", null);
  url = setParam(url, "sslmode", "require");
  return setParam(url, "sslaccept", "accept_invalid_certs");
}
