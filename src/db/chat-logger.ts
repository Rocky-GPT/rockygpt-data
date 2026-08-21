import { getRuntimePool } from './runtime-pool';
import { notifyLogsChanged } from './log-events';
import type { SourceReference } from '../data-v2/types';

/**
 * How a question reached the service.
 *
 * This is the domain of the `question_origin` column, so it is defined here
 * rather than beside the classifier that produces it — the brain depends on
 * this package, and a type flowing the other way would close a cycle.
 */
export type QuestionOrigin = 'client' | 'dev' | 'bot';

/** A single structured value pulled from campus data for a logged turn. */
export interface Fact {
  key: string;
  kind: 'text' | 'number' | 'boolean' | 'date' | 'time' | 'list';
  value: string | number | boolean | readonly string[];
  sourceLabel?: string;
  sourceId?: string;
}

export interface ChatLogEntry {
  id?: string;
  sessionId: string;
  visitorId?: string;
  userMessage: string;
  assistantMessage: string;
  route: string;
  questionOrigin?: QuestionOrigin;
  toolsInvoked?: string[];
  toolArguments?: Record<string, unknown>;
  citations?: SourceReference[];
  factsExtracted?: Fact[];
  debugInfo?: Record<string, unknown>;
  latencyMs: number;
  feedback?: string | null;
}

let tableInitialized = false;

/**
 * Ensures the `rockygpt_v2.chat_logs` table, indexes, origin, debug, and visitor_id columns exist in PostgreSQL.
 */
export async function initChatLogsTable(): Promise<void> {
  if (tableInitialized) return;

  const pool = getRuntimePool();
  if (!pool) return;

  const ddl = `
    CREATE TABLE IF NOT EXISTS rockygpt_v2.chat_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id TEXT NOT NULL,
      visitor_id TEXT,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      route TEXT NOT NULL,
      question_origin TEXT NOT NULL DEFAULT 'client',
      tools_invoked JSONB DEFAULT '[]'::jsonb,
      tool_arguments JSONB DEFAULT '{}'::jsonb,
      citations JSONB DEFAULT '[]'::jsonb,
      facts_extracted JSONB DEFAULT '[]'::jsonb,
      debug_info JSONB DEFAULT '{}'::jsonb,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      feedback TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE rockygpt_v2.chat_logs ADD COLUMN IF NOT EXISTS visitor_id TEXT;
    ALTER TABLE rockygpt_v2.chat_logs ADD COLUMN IF NOT EXISTS question_origin TEXT NOT NULL DEFAULT 'client';
    ALTER TABLE rockygpt_v2.chat_logs ADD COLUMN IF NOT EXISTS debug_info JSONB DEFAULT '{}'::jsonb;

    CREATE INDEX IF NOT EXISTS idx_chat_logs_created_at ON rockygpt_v2.chat_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_logs_session_id ON rockygpt_v2.chat_logs(session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_logs_visitor_id ON rockygpt_v2.chat_logs(visitor_id);
    CREATE INDEX IF NOT EXISTS idx_chat_logs_origin ON rockygpt_v2.chat_logs(question_origin);
  `;

  try {
    await pool.query(ddl);
    tableInitialized = true;
  } catch (err) {
    console.error('Failed to initialize rockygpt_v2.chat_logs table:', err);
  }
}

/**
 * Asynchronously logs a chat turn into PostgreSQL without blocking the request response.
 */
export function logChatTurnAsync(entry: ChatLogEntry): void {
  // Fire-and-forget promise
  void (async () => {
    try {
      if (!tableInitialized) {
        await initChatLogsTable();
      }

      const pool = getRuntimePool();
      if (!pool) return;

      const insertSql = `
        INSERT INTO rockygpt_v2.chat_logs (
          id,
          session_id,
          visitor_id,
          user_message,
          assistant_message,
          route,
          question_origin,
          tools_invoked,
          tool_arguments,
          citations,
          facts_extracted,
          debug_info,
          latency_ms,
          feedback
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (id) DO UPDATE SET
          feedback = COALESCE(EXCLUDED.feedback, rockygpt_v2.chat_logs.feedback)
      `;

      const values = [
        entry.id || crypto.randomUUID(),
        entry.sessionId,
        entry.visitorId || entry.sessionId,
        entry.userMessage,
        entry.assistantMessage,
        entry.route,
        entry.questionOrigin || 'client',
        JSON.stringify(entry.toolsInvoked || []),
        JSON.stringify(entry.toolArguments || {}),
        JSON.stringify(entry.citations || []),
        JSON.stringify(entry.factsExtracted || []),
        JSON.stringify(entry.debugInfo || {}),
        Math.max(0, Math.round(entry.latencyMs)),
        entry.feedback || null,
      ];

      await pool.query(insertSql, values);
      notifyLogsChanged();
    } catch (err) {
      console.error('Failed to log chat turn to PostgreSQL:', err);
    }
  })();
}
