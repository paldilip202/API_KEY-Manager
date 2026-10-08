const redis = require('./redis');

const ALERT_PERCENT = 80;
const COUNTER_TTL_SECONDS = 40 * 24 * 60 * 60;

async function sendWebhook(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    console.log(`quota webhook sent to ${url}: ${res.status}`);
  } catch (err) {
    console.error('quota webhook failed:', err.message);
  }
}

async function quotaAlert(req, res, next) {
  try {
    const { id, name, monthly_quota, webhook_url } = req.apiKey;
    if (!monthly_quota) return next();

    const month = new Date().toISOString().slice(0, 7);
    const counterKey = `quota:${id}:${month}`;

    const results = await redis
      .multi()
      .incr(counterKey)
      .expire(counterKey, COUNTER_TTL_SECONDS)
      .exec();
    const used = results[0][1];

    const threshold = Math.ceil((monthly_quota * ALERT_PERCENT) / 100);
    if (used === threshold && webhook_url) {
      sendWebhook(webhook_url, {
        event: 'quota.threshold_reached',
        key_id: id,
        key_name: name,
        threshold_percent: ALERT_PERCENT,
        used,
        quota: monthly_quota,
        month,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { quotaAlert };