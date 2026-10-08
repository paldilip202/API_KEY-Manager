const crypto = require('crypto');
const pool = require('./db');
const redis = require('./redis');

function generateRawKey() {
  return 'ak_live_' + crypto.randomBytes(24).toString('hex');
}

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

async function createKey({ name, scopes, rateLimitPerMin, expiresAt, monthlyQuota, webhookUrl }) {
  const rawKey = generateRawKey();
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  const { rows } = await pool.query(
    `INSERT INTO api_keys
       (name, key_prefix, key_hash, scopes, rate_limit_per_min, expires_at, monthly_quota, webhook_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, key_prefix, scopes, rate_limit_per_min, created_at, expires_at, monthly_quota`,
    [name, keyPrefix, keyHash, scopes, rateLimitPerMin, expiresAt || null, monthlyQuota || null, webhookUrl || null]
  );

  return { ...rows[0], key: rawKey };
}

async function listKeys() {
  const { rows } = await pool.query(
    `SELECT id, name, key_prefix, scopes, rate_limit_per_min,
            monthly_quota, created_at, revoked_at, expires_at
     FROM api_keys
     ORDER BY created_at DESC`
  );
  return rows;
}

async function findKeyByHash(keyHash) {
  const { rows } = await pool.query(
    `SELECT id, name, scopes, rate_limit_per_min, revoked_at, expires_at,
            monthly_quota, webhook_url
     FROM api_keys
     WHERE key_hash = $1`,
    [keyHash]
  );
  return rows[0] || null;
}

async function revokeKey(id) {
  const { rows } = await pool.query(
    `UPDATE api_keys
     SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING key_hash`,
    [id]
  );
  if (rows.length === 0) return false;
  await redis.del(`key:${rows[0].key_hash}`);
  return true;
}

module.exports = { hashKey, createKey, listKeys, findKeyByHash, revokeKey };