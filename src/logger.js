const pool = require('./db');

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    if (!req.keyId) return;

    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    const endpoint = req.originalUrl.split('?')[0].slice(0, 200);
    const isError = res.statusCode >= 400 ? 1 : 0;

    pool
      .query(
        `WITH log AS (
           INSERT INTO request_logs (key_id, method, endpoint, status_code, latency_ms)
           VALUES ($1, $2, $3, $4, $5)
         )
         INSERT INTO usage_daily (key_id, day, requests, errors, total_latency_ms)
         VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1, $6, $5)
         ON CONFLICT (key_id, day) DO UPDATE SET
           requests = usage_daily.requests + 1,
           errors = usage_daily.errors + EXCLUDED.errors,
           total_latency_ms = usage_daily.total_latency_ms + EXCLUDED.total_latency_ms`,
        [req.keyId, req.method, endpoint, res.statusCode, latencyMs, isError]
      )
      .catch((err) => console.error('log insert failed:', err.message));
  });

  next();
}

module.exports = { requestLogger };