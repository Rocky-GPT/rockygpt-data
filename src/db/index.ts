/**
 * @module db
 * Shared PostgreSQL connection pool for the RockyGPT backend.
 *
 * Every server-side module (API routes, ingestion scripts, QA utilities)
 * imports the singleton {@link db} pool from this file to avoid creating
 * redundant database connections.
 */

import dotenv from 'dotenv';
import { Pool } from 'pg';
import { dataRootPath } from '../paths';

// Load .env explicitly for local scripts outside Next.js runtime
dotenv.config({ path: dataRootPath('.env') });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not defined in .env');
}

/**
 * Shared PostgreSQL connection pool for API routes, ingestion scripts, and QA utilities.
 */
export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 60000, // Increase to 1 minute
  connectionTimeoutMillis: 10000, // Increase to 10 seconds
});
