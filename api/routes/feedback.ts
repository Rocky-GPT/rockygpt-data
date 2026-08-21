import { getRuntimePool } from '../../src/db/runtime-pool';
import { notifyLogsChanged } from '../../src/db/log-events';

import type { ApiHandler, ApiResponse } from '../http';

/**
 * Mirrors the response helper these handlers were written against, so the
 * logic below is the same code that ran inside the web app.
 */
const json = (
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): ApiResponse => ({ status: init?.status ?? 200, body, headers: init?.headers });


let feedbackTableReady = false;

async function ensureFeedbackTable() {
  if (feedbackTableReady) return;
  const pool = getRuntimePool();
  if (!pool) return;

  const sql = `
    CREATE TABLE IF NOT EXISTS rockygpt_v2.feedback (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      category TEXT,
      comments TEXT,
      question TEXT NOT NULL DEFAULT '',
      answer TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      CONSTRAINT feedback_request_id_unique UNIQUE (request_id)
    );

    ALTER TABLE rockygpt_v2.feedback ADD COLUMN IF NOT EXISTS category TEXT;
    ALTER TABLE rockygpt_v2.feedback ADD COLUMN IF NOT EXISTS comments TEXT;
    ALTER TABLE rockygpt_v2.feedback ADD COLUMN IF NOT EXISTS question TEXT NOT NULL DEFAULT '';
    ALTER TABLE rockygpt_v2.feedback ADD COLUMN IF NOT EXISTS answer TEXT NOT NULL DEFAULT '';
    ALTER TABLE rockygpt_v2.feedback DROP CONSTRAINT IF EXISTS feedback_request_id_fkey;

    CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON rockygpt_v2.feedback(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_request_id ON rockygpt_v2.feedback(request_id);
  `;

  try {
    await pool.query(sql);
    feedbackTableReady = true;
  } catch (err) {
    console.error('Failed to init rockygpt_v2.feedback table:', err);
  }
}

export const postFeedback: ApiHandler = async (req) => {
  try {
    const body = req.body as Record<string, unknown>;
    const requestId = body.requestId || body.id;
    const rating = typeof body.rating === 'number' ? body.rating : (body.rating === 'up' ? 1 : -1);
    const category = body.category || null;
    const comments = body.comments || null;
    const question = body.question || '';
    const answer = body.answer || '';

    if (!requestId) {
      return json({ error: 'Missing requestId' }, { status: 400 });
    }

    const pool = getRuntimePool();
    if (!pool) {
      return json({ error: 'Database unavailable' }, { status: 503 });
    }

    await ensureFeedbackTable();

    // 1. Insert or update in rockygpt_v2.feedback
    const insertFeedbackSql = `
      INSERT INTO rockygpt_v2.feedback (
        request_id,
        rating,
        category,
        comments,
        question,
        answer
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (request_id) DO UPDATE SET
        rating = EXCLUDED.rating,
        category = COALESCE(EXCLUDED.category, rockygpt_v2.feedback.category),
        comments = COALESCE(EXCLUDED.comments, rockygpt_v2.feedback.comments),
        created_at = NOW()
    `;

    await pool.query(insertFeedbackSql, [
      String(requestId),
      rating,
      category,
      comments,
      question,
      answer,
    ]);

    // 2. Mirror the vote onto the turn's chat_logs row.
    // Strictly by id: requestId is the turn UUID, which the chat response
    // carries as both its requestId and its chat_logs.id. Matching session_id
    // too would stamp one rating onto every turn of the conversation.
    const feedbackLabel = rating === 1 ? 'positive' : 'negative';
    try {
      await pool.query(
        `UPDATE rockygpt_v2.chat_logs SET feedback = $1 WHERE id::text = $2`,
        [feedbackLabel, String(requestId)]
      );
    } catch {
      // Non-critical if chat_logs turn was not found by UUID
    }

    notifyLogsChanged();

    return json({ success: true, requestId, rating, category });
  } catch (error) {
    console.error('Feedback API error:', error);
    return json({ error: 'Failed to record feedback' }, { status: 500 });
  }
}
