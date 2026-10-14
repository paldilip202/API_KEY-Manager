const express = require('express');
const pool = require('./db');
const { PLANS, MAX_ACTIVE_KEYS } = require('./plans');
const redis = require('./redis');
const { hashPassword, verifyPassword } = require('./passwords');
const {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSession,
  destroySession,
} = require('./sessions');
const { requireUser } = require('./userAuth');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setSessionCookie(res, sid) {
  res.cookie(COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    plan: user.plan,
    rate_limit_per_min: PLANS[user.plan],
  };
}

router.post('/signup', async (req, res) => {
  const { email: rawEmail, password: rawPassword } = req.body || {};
  const email = String(rawEmail || '').trim().toLowerCase();
  const password = String(rawPassword || '');

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'password_too_short', message: 'use at least 8 characters' });
  }

  const passwordHash = await hashPassword(password);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, plan`,
      [email, passwordHash]
    );
    const sid = await createSession(rows[0].id);
    setSessionCookie(res, sid);
    res.status(201).json(publicUser(rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'email_taken' });
    }
    throw err;
  }
});

router.post('/login', async (req, res) => {
  const { email: rawEmail, password: rawPassword } = req.body || {};
  const email = String(rawEmail || '').trim().toLowerCase();
  const password = String(rawPassword || '');

  const { rows } = await pool.query(
    'SELECT id, email, plan, password_hash FROM users WHERE email = $1',
    [email]
  );
  const user = rows[0];
  const ok = user && (await verifyPassword(password, user.password_hash));
  if (!ok) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const sid = await createSession(user.id);
  setSessionCookie(res, sid);
  res.json(publicUser(user));
});

router.post('/logout', async (req, res) => {
  const sid = req.cookies?.[COOKIE_NAME];
  if (sid) await destroySession(sid);
  res.clearCookie(COOKIE_NAME);
  res.json({ loggedOut: true });
});

router.get('/me', requireUser, (req, res) => {
  res.json(publicUser(req.user));
});

router.post('/plan', requireUser, async (req, res) => {
  const { plan } = req.body || {};
  if (!Object.hasOwn(PLANS, plan)) {
    return res.status(400).json({ error: 'invalid_plan', message: 'plan must be free or pro' });
  }
  if (plan === req.user.plan) {
    return res.json({ plan, rate_limit_per_min: PLANS[plan], changed: false });
  }

  if (plan === 'free') {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS active
       FROM api_keys
       WHERE user_id = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [req.user.id]
    );
    if (rows[0].active > MAX_ACTIVE_KEYS.free) {
      return res.status(409).json({
        error: 'revoke_keys_first',
        message: `the free plan allows ${MAX_ACTIVE_KEYS.free} active keys; you have ${rows[0].active}`,
      });
    }
  }

  const client = await pool.connect();
  let hashes;
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET plan = $1 WHERE id = $2', [plan, req.user.id]);
    const result = await client.query(
      'UPDATE api_keys SET rate_limit_per_min = $1 WHERE user_id = $2 RETURNING key_hash',
      [PLANS[plan], req.user.id]
    );
    hashes = result.rows.map((r) => r.key_hash);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (hashes.length > 0) {
    await redis.del(...hashes.map((h) => `key:${h}`));
  }

  res.json({
    plan,
    rate_limit_per_min: PLANS[plan],
    changed: true,
    keys_updated: hashes.length,
  });
});

router.get('/plans', (req, res) => {
  res.json(
    Object.keys(PLANS).map((id) => ({
      id,
      rate_limit_per_min: PLANS[id],
      max_active_keys: MAX_ACTIVE_KEYS[id],
    }))
  );
});

module.exports = router;