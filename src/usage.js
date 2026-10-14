const pool = require('./db');

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

async function getRecentLogs(keyId, limit) {
  const { rows } = await pool.query(
    `SELECT method, endpoint, status_code, latency_ms, tokens, created_at
     FROM request_logs
     WHERE key_id = $1 AND created_at >= now() - interval '30 days'
     ORDER BY created_at DESC
     LIMIT $2`,
    [keyId, limit]
  );
  return rows;
}

async function getUsage(keyId, from, to) {
  const totals = await pool.query(
    `WITH t AS (SELECT (now() AT TIME ZONE 'UTC')::date AS d)
     SELECT
       COALESCE(SUM(u.requests) FILTER (WHERE u.day = t.d), 0) AS today,
       COALESCE(SUM(u.requests) FILTER (WHERE u.day >= date_trunc('month', t.d)::date), 0) AS this_month,
       COALESCE(SUM(u.requests), 0) AS all_time,
       COALESCE(SUM(u.tokens) FILTER (WHERE u.day = t.d), 0) AS tokens_today,
       COALESCE(SUM(u.tokens) FILTER (WHERE u.day >= date_trunc('month', t.d)::date), 0) AS tokens_this_month,
       COALESCE(SUM(u.tokens), 0) AS tokens_all_time
     FROM usage_daily u, t
     WHERE u.key_id = $1`,
    [keyId]
  );

  const daily = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, requests, errors, total_latency_ms, tokens
     FROM usage_daily
     WHERE key_id = $1 AND day BETWEEN $2 AND $3
     ORDER BY day`,
    [keyId, from, to]
  );

  let requests = 0;
  let errors = 0;
  let latency = 0;
  let tokens = 0;
  const days = daily.rows.map((r) => {
    const rq = Number(r.requests);
    const er = Number(r.errors);
    const tk = Number(r.tokens);
    requests += rq;
    errors += er;
    latency += r.total_latency_ms;
    tokens += tk;
    return {
      day: r.day,
      requests: rq,
      errors: er,
      error_rate: rq ? round(er / rq, 4) : 0,
      avg_latency_ms: rq ? round(r.total_latency_ms / rq, 2) : 0,
      tokens: tk,
    };
  });

  const t = totals.rows[0];
  return {
    key_id: keyId,
    today: Number(t.today),
    this_month: Number(t.this_month),
    all_time: Number(t.all_time),
    tokens: {
      today: Number(t.tokens_today),
      this_month: Number(t.tokens_this_month),
      all_time: Number(t.tokens_all_time),
    },
    range: {
      from,
      to,
      requests,
      errors,
      error_rate: requests ? round(errors / requests, 4) : 0,
      avg_latency_ms: requests ? round(latency / requests, 2) : 0,
      tokens,
    },
    daily: days,
  };
}

async function getAccountUsage(userId, from, to, keyId) {
  const totals = await pool.query(
    `WITH t AS (SELECT (now() AT TIME ZONE 'UTC')::date AS d)
     SELECT
       COALESCE(SUM(u.requests) FILTER (WHERE u.day = t.d), 0) AS today,
       COALESCE(SUM(u.requests) FILTER (WHERE u.day >= date_trunc('month', t.d)::date), 0) AS this_month,
       COALESCE(SUM(u.requests), 0) AS all_time,
       COALESCE(SUM(u.tokens) FILTER (WHERE u.day = t.d), 0) AS tokens_today,
       COALESCE(SUM(u.tokens) FILTER (WHERE u.day >= date_trunc('month', t.d)::date), 0) AS tokens_this_month,
       COALESCE(SUM(u.tokens), 0) AS tokens_all_time
     FROM usage_daily u
     JOIN api_keys k ON k.id = u.key_id
     CROSS JOIN t
     WHERE k.user_id = $1 AND ($2::uuid IS NULL OR u.key_id = $2)`,
    [userId, keyId]
  );

  const daily = await pool.query(
    `SELECT to_char(u.day, 'YYYY-MM-DD') AS day,
            SUM(u.requests) AS requests,
            SUM(u.errors) AS errors,
            SUM(u.total_latency_ms) AS total_latency_ms,
            SUM(u.tokens) AS tokens
     FROM usage_daily u
     JOIN api_keys k ON k.id = u.key_id
     WHERE k.user_id = $1
       AND ($2::uuid IS NULL OR u.key_id = $2)
       AND u.day BETWEEN $3 AND $4
     GROUP BY u.day
     ORDER BY u.day`,
    [userId, keyId, from, to]
  );

  const byKey = await pool.query(
    `SELECT k.id, k.name, k.key_prefix,
            SUM(u.requests) AS requests,
            SUM(u.errors) AS errors,
            SUM(u.tokens) AS tokens
     FROM usage_daily u
     JOIN api_keys k ON k.id = u.key_id
     WHERE k.user_id = $1
       AND ($2::uuid IS NULL OR k.id = $2)
       AND u.day BETWEEN $3 AND $4
     GROUP BY k.id, k.name, k.key_prefix
     ORDER BY SUM(u.requests) DESC`,
    [userId, keyId, from, to]
  );

  let requests = 0;
  let errors = 0;
  let latency = 0;
  let tokens = 0;
  const days = daily.rows.map((r) => {
    const rq = Number(r.requests);
    const er = Number(r.errors);
    const tk = Number(r.tokens);
    requests += rq;
    errors += er;
    latency += r.total_latency_ms;
    tokens += tk;
    return {
      day: r.day,
      requests: rq,
      errors: er,
      error_rate: rq ? round(er / rq, 4) : 0,
      avg_latency_ms: rq ? round(r.total_latency_ms / rq, 2) : 0,
      tokens: tk,
    };
  });

  const t = totals.rows[0];
  return {
    key_id: keyId,
    today: Number(t.today),
    this_month: Number(t.this_month),
    all_time: Number(t.all_time),
    tokens: {
      today: Number(t.tokens_today),
      this_month: Number(t.tokens_this_month),
      all_time: Number(t.tokens_all_time),
    },
    range: {
      from,
      to,
      requests,
      errors,
      error_rate: requests ? round(errors / requests, 4) : 0,
      avg_latency_ms: requests ? round(latency / requests, 2) : 0,
      tokens,
    },
    daily: days,
    by_key: byKey.rows.map((r) => ({
      id: r.id,
      name: r.name,
      key_prefix: r.key_prefix,
      requests: Number(r.requests),
      errors: Number(r.errors),
      tokens: Number(r.tokens),
    })),
  };
}

async function getAccountLogs(userId, keyId, limit) {
  const { rows } = await pool.query(
    `SELECT l.created_at, l.key_id, k.name AS key_name, l.method, l.endpoint,
            l.status_code, l.latency_ms, l.tokens
     FROM request_logs l
     JOIN api_keys k ON k.id = l.key_id
     WHERE k.user_id = $1
       AND ($2::uuid IS NULL OR l.key_id = $2)
       AND l.created_at >= now() - interval '30 days'
     ORDER BY l.created_at DESC
     LIMIT $3`,
    [userId, keyId, limit]
  );
  return rows;
}

module.exports = { getRecentLogs, getUsage, getAccountUsage, getAccountLogs };