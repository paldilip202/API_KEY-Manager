const redis = require('./redis');

const WINDOW_SECONDS = 60;

async function rateLimit(req, res, next) {
  try {
    const limit = req.apiKey.rate_limit_per_min;
    const nowMs = Date.now();
    const bucket = Math.floor(nowMs / (WINDOW_SECONDS * 1000));
    const redisKey = `rl:${req.apiKey.id}:${bucket}`;

    const results = await redis
      .multi()
      .incr(redisKey)
      .expire(redisKey, WINDOW_SECONDS)
      .exec();
    const count = results[0][1];

    const resetSeconds = Math.ceil(
      ((bucket + 1) * WINDOW_SECONDS * 1000 - nowMs) / 1000
    );

    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
    res.set('X-RateLimit-Reset', String(resetSeconds));

    if (count > limit) {
      res.set('Retry-After', String(resetSeconds));
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        retry_after_seconds: resetSeconds,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { rateLimit };