import { Pool } from 'pg';

type PoolRegistry = Map<string, Pool>;

const globalPools = globalThis as typeof globalThis & {
  __rockygptPgPools?: PoolRegistry;
};

function registry(): PoolRegistry {
  globalPools.__rockygptPgPools ??= new Map<string, Pool>();
  return globalPools.__rockygptPgPools;
}

/**
 * Returns one small process-wide pool per connection string. The configured
 * Neon URL is already a PgBouncer endpoint, so creating a large node-postgres
 * pool in every route or repository only multiplies idle connections.
 */
export function getRuntimePool(connectionString = process.env.DATABASE_URL): Pool | null {
  if (!connectionString) return null;

  const pools = registry();
  const existing = pools.get(connectionString);
  if (existing) return existing;

  const pool = new Pool({
    connectionString,
    max: Number(process.env.POSTGRES_RUNTIME_POOL_MAX || 3),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    application_name: 'rockygpt-runtime',
  });

  // node-postgres emits 'error' on the pool when a client fails while idle,
  // and an unhandled 'error' event terminates the process. That is not a
  // theoretical risk here: the endpoint is serverless Postgres, which drops
  // idle connections as a matter of course, so a dropped socket
  // (EHOSTUNREACH/ECONNRESET) on a checked-in client took the whole data
  // service down mid-session. The pool discards the broken client and opens
  // a fresh one on the next checkout, so surviving this is just a matter of
  // listening: an idle-connection failure must not outrank a live request.
  pool.on('error', (error) => {
    console.error('[runtime-pool] idle client error (connection discarded):', error);
  });

  pools.set(connectionString, pool);
  return pool;
}
