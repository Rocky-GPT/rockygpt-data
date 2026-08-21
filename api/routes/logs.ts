import { getRuntimePool } from '../../src/db/runtime-pool';
import { initChatLogsTable } from '../../src/db/chat-logger';

import type { ApiHandler, ApiResponse } from '../http';

/**
 * Mirrors the response helper these handlers were written against, so the
 * logic below is the same code that ran inside the web app.
 */
const json = (
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): ApiResponse => ({ status: init?.status ?? 200, body, headers: init?.headers });



export const getLogs: ApiHandler = async (request) => {
  try {
    await initChatLogsTable();
    const pool = getRuntimePool();
    if (!pool) {
      return json({ error: 'Database pool unavailable' }, { status: 500 });
    }

    const searchParams = request.url.searchParams;
    const search = (searchParams.get('search') || '').trim();
    const routeParam = (searchParams.get('route') || '').trim();
    const originParam = (searchParams.get('origin') || '').trim();
    const sessionId = (searchParams.get('sessionId') || '').trim();
    // Only an explicit ?version= counts as a conditional request. Reading
    // if-none-match here made the browser's *automatic* revalidation (which it
    // sends on its own once it has cached an ETag) look like the client asking
    // to skip the payload — so a plain page load answered { modified: false }
    // with no logs and the dashboard rendered "No chat logs found".
    const clientVersion = (searchParams.get('version') || '').trim();
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
    const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10));

    // Fast DB watermark check: checks max timestamp, row count, and latest ID in <1ms
    const watermarkResult = await pool.query(`
      SELECT
        COUNT(*)::text AS log_count,
        COALESCE(EXTRACT(EPOCH FROM MAX(created_at)), 0)::text AS max_log_ts,
        COALESCE(MAX(id::text), '') AS latest_log_id
      FROM rockygpt_v2.chat_logs
    `);
    let fbCount = '0';
    let maxFbTs = '0';
    try {
      const fbResult = await pool.query(`
        SELECT
          COUNT(*)::text AS fb_count,
          COALESCE(EXTRACT(EPOCH FROM MAX(created_at)), 0)::text AS max_fb_ts
        FROM rockygpt_v2.feedback
      `);
      if (fbResult.rows[0]) {
        fbCount = fbResult.rows[0].fb_count || '0';
        maxFbTs = fbResult.rows[0].max_fb_ts || '0';
      }
    } catch {
      // Non-critical if feedback table is empty/uninitialized
    }

    const logRow = watermarkResult.rows[0] || { log_count: '0', max_log_ts: '0', latest_log_id: '' };
    const dbVersion = `v_${logRow.log_count}_${logRow.max_log_ts}_${logRow.latest_log_id}_${fbCount}_${maxFbTs}`;

    // If client supplied its last known version and the database has not changed, return 304 / modified: false
    if (clientVersion && clientVersion === dbVersion) {
      return json(
        { modified: false, version: dbVersion },
        {
          headers: {
            ETag: dbVersion,
            'Cache-Control': 'no-store',
          },
        }
      );
    }

    const whereClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (search) {
      whereClauses.push(
        `(t.user_message ILIKE $${paramIndex} OR t.assistant_message ILIKE $${paramIndex} OR t.session_id ILIKE $${paramIndex})`
      );
      values.push(`%${search}%`);
      paramIndex++;
    }

    if (originParam && originParam !== 'all') {
      const origins = originParam.split(',').map((s) => s.trim()).filter((s) => s && s !== 'all');
      if (origins.length === 1) {
        whereClauses.push(`COALESCE(t.question_origin, 'client') = $${paramIndex}`);
        values.push(origins[0]);
        paramIndex++;
      } else if (origins.length > 1) {
        whereClauses.push(`COALESCE(t.question_origin, 'client') = ANY($${paramIndex}::text[])`);
        values.push(origins);
        paramIndex++;
      }
    }

    if (routeParam && routeParam !== 'all') {
      const routes = routeParam.split(',').map((s) => s.trim()).filter((s) => s && s !== 'all');
      if (routes.length > 0) {
        whereClauses.push(`t.route = ANY($${paramIndex}::text[])`);
        values.push(routes);
        paramIndex++;
      }
    }

    if (sessionId) {
      whereClauses.push(`t.session_id = $${paramIndex}`);
      values.push(sessionId);
      paramIndex++;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Feedback is keyed strictly to the turn: the requestId the client submits
    // is the same UUID as chat_logs.id. Matching session_id as well would
    // attach one rating to every turn in the
    // conversation now that sessions span multiple turns. request_id is unique,
    // so this join yields at most one row per turn.
    const feedbackJoinSql = `
      LEFT JOIN rockygpt_v2.feedback fb
        ON fb.request_id::text = t.id::text
    `;

    // 1. Fetch filtered logs
    const logsQuery = `
      SELECT
        t.id,
        t.session_id,
        t.visitor_id,
        t.user_message,
        t.assistant_message,
        t.route,
        t.question_origin,
        t.tools_invoked,
        t.tool_arguments,
        t.citations,
        t.facts_extracted,
        COALESCE(t.debug_info, '{}'::jsonb) AS debug_info,
        t.latency_ms,
        t.feedback,
        fb.rating AS feedback_rating,
        fb.category AS feedback_category,
        fb.comments AS feedback_comment,
        t.created_at
      FROM rockygpt_v2.chat_logs t
      ${feedbackJoinSql}
      ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    const logsValues = [...values, limit, offset];
    const logsResult = await pool.query(logsQuery, logsValues);

    // 2. Fetch metrics
    const metricsQuery = `
      SELECT
        COUNT(*)::int AS total_logs,
        COALESCE(AVG(latency_ms), 0)::int AS avg_latency_ms,
        COUNT(DISTINCT session_id)::int AS unique_sessions,
        COUNT(DISTINCT COALESCE(visitor_id, session_id))::int AS unique_visitors,
        COUNT(*) FILTER (WHERE route ILIKE '%error%')::int AS error_count,
        COUNT(*) FILTER (WHERE COALESCE(question_origin, 'client') = 'client')::int AS client_count,
        COUNT(*) FILTER (WHERE question_origin = 'dev')::int AS dev_count,
        COUNT(*) FILTER (WHERE question_origin = 'bot')::int AS bot_count
      FROM rockygpt_v2.chat_logs
    `;
    const metricsResult = await pool.query(metricsQuery);
    const metrics = metricsResult.rows[0] || {
      total_logs: 0,
      avg_latency_ms: 0,
      unique_sessions: 0,
      error_count: 0,
      client_count: 0,
      dev_count: 0,
      bot_count: 0,
    };

    return json({
      modified: true,
      version: dbVersion,
      logs: logsResult.rows,
      metrics: {
        totalLogs: metrics.total_logs,
        avgLatencyMs: metrics.avg_latency_ms,
        uniqueSessions: metrics.unique_sessions,
        groundedCount: metrics.grounded_count,
        toolCount: metrics.tool_count,
        errorCount: metrics.error_count,
        clientCount: metrics.client_count,
        devCount: metrics.dev_count,
        botCount: metrics.bot_count,
      },
      pagination: {
        limit,
        offset,
        count: logsResult.rows.length,
      },
    }, {
      headers: {
        ETag: dbVersion,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return json({ error: 'Failed to fetch logs' }, { status: 500 });
  }
}
