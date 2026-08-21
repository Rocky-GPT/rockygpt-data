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
  pools.set(connectionString, pool);
  return pool;
}
