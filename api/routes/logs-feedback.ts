import { getRuntimePool } from '../../src/db/runtime-pool';

import type { ApiHandler, ApiResponse } from '../http';

/**
 * Mirrors the response helper these handlers were written against, so the
 * logic below is the same code that ran inside the web app.
 */
const json = (
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): ApiResponse => ({ status: init?.status ?? 200, body, headers: init?.headers });


export const postLogFeedback: ApiHandler = async (req) => {
  try {
    const { logId, feedback } = (req.body ?? {}) as { logId?: string; feedback?: string };

    if (!logId) {
      return json({ error: 'Missing logId' }, { status: 400 });
    }

    const pool = getRuntimePool();
    if (!pool) {
      return json({ error: 'Database unavailable' }, { status: 503 });
    }

    await pool.query(
      `UPDATE rockygpt_v2.chat_logs SET feedback = $1 WHERE id = $2`,
      [feedback || null, logId]
    );

    return json({ success: true, logId, feedback });
  } catch (error) {
    console.error('Failed to update log feedback:', error);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
}
