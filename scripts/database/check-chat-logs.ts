import 'dotenv/config';
import { getRuntimePool } from '../../src/db/runtime-pool';

async function main() {
  const pool = getRuntimePool();
  if (!pool) throw new Error('No pool');
  const res = await pool.query('SELECT id, user_message, debug_info FROM rockygpt_v2.chat_logs ORDER BY created_at DESC LIMIT 5');
  console.log('Chat logs with debug_info:');
  console.log(JSON.stringify(res.rows, null, 2));
}

main().catch(console.error);
