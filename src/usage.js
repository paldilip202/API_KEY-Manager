const pool = require('./db');

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

async function getRecentLogs(keyId, limit) {
  const { rows } = await pool.query(
    `SELECT method, endpoint, status_code, latency_ms, created_at
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
       COALESCE(SUM(u.requests), 0) AS all_time
     FROM usage_daily u, t
     WHERE u.key_id = $1`,
    [keyId]
  );

  const daily = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, requests, errors, total_latency_ms
     FROM usage_daily
     WHERE key_id = $1 AND day BETWEEN $2 AND $3
     ORDER BY day`,
    [keyId, from, to]
  );

  let requests = 0;
  let errors = 0;
  let latency = 0;
  const days = daily.rows.map((r) => {
    const rq = Number(r.requests);
    const er = Number(r.errors);
    requests += rq;
    errors += er;
    latency += r.total_latency_ms;
    return {
      day: r.day,
      requests: rq,
      errors: er,
      error_rate: rq ? round(er / rq, 4) : 0,
      avg_latency_ms: rq ? round(r.total_latency_ms / rq, 2) : 0,
    };
  });

  const t = totals.rows[0];
  return {
    key_id: keyId,
    today: Number(t.today),
    this_month: Number(t.this_month),
    all_time: Number(t.all_time),
    range: {
      from,
      to,
      requests,
      errors,
      error_rate: requests ? round(errors / requests, 4) : 0,
      avg_latency_ms: requests ? round(latency / requests, 2) : 0,
    },
    daily: days,
  };
}

module.exports = { getRecentLogs, getUsage };