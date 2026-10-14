const express = require('express');
const pool = require('./db');
const { PLANS, MAX_ACTIVE_KEYS } = require('./plans');
const { requireUser } = require('./userAuth');
const { createKey, revokeKey } = require('./keys');
const { scopesFromPermissions, permissionsFromScopes } = require('./permissions');

const router = express.Router();
router.use(requireUser);

const UUID_RE = /^[0-9a-f-]{36}$/i;

function publicKey(row) {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    permissions: permissionsFromScopes(row.scopes),
    rate_limit_per_min: row.rate_limit_per_min,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at ?? null,
  };
}

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, key_prefix, scopes, rate_limit_per_min,
            created_at, expires_at, revoked_at
     FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(rows.map(publicKey));
});

router.post('/', async (req, res) => {
  const { name, permissions, expiresAt } = req.body || {};

  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length > 60) {
    return res.status(400).json({
      error: 'invalid_name',
      message: 'name is required (max 60 characters)',
    });
  }

  const scopes = scopesFromPermissions(permissions);
  if (!scopes) {
    return res.status(400).json({
      error: 'invalid_permissions',
      message: 'choose one or more of: models, chat',
    });
  }

  let expiry = null;
  if (expiresAt) {
    expiry = new Date(expiresAt);
    if (isNaN(expiry.getTime()) || expiry <= new Date()) {
      return res.status(400).json({
        error: 'invalid_expires_at',
        message: 'expiresAt must be a future ISO date-time',
      });
    }
  }

  const { rows } = await pool.query(
    `SELECT count(*)::int AS active
     FROM api_keys
     WHERE user_id = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())`,
    [req.user.id]
  );
  const max = MAX_ACTIVE_KEYS[req.user.plan];
  if (rows[0].active >= max) {
    return res.status(403).json({
      error: 'key_limit_reached',
      message: `your ${req.user.plan} plan allows ${max} active keys`,
    });
  }

  const created = await createKey({
    name: cleanName,
    scopes,
    rateLimitPerMin: PLANS[req.user.plan],
    expiresAt: expiry,
    userId: req.user.id,
  });
  res.status(201).json({ ...publicKey(created), key: created.key });
});

router.delete('/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(404).json({ error: 'not_found' });
  }
  const revoked = await revokeKey(req.params.id, req.user.id);
  if (!revoked) return res.status(404).json({ error: 'not_found' });
  res.json({ revoked: true });
});

module.exports = router;