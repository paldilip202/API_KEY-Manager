const express = require('express');
const pool = require('./db');
const { requireUser } = require('./userAuth');
const { getAccountUsage, getAccountLogs } = require('./usage');

const router = express.Router();

const UUID_RE = /^[0-9a-f-]{36}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value) {
  return (
    typeof value === 'string' &&
    DATE_RE.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

// ok is false when the key does not exist or belongs to someone else.
// keyId is null when no filter was asked for.
async function resolveKeyFilter(userId, keyId) {
  if (keyId === undefined) return { ok: true, keyId: null };
  if (typeof keyId !== 'string' || !UUID_RE.test(keyId)) return { ok: false };
  const { rows } = await pool.query(
    'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2',
    [keyId, userId]
  );
  return rows[0] ? { ok: true, keyId } : { ok: false };
}

router.get('/usage', requireUser, async (req, res) => {
  const key = await resolveKeyFilter(req.user.id, req.query.key_id);
  if (!key.ok) return res.status(404).json({ error: 'not_found' });

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const from = req.query.from ?? weekAgo;
  const to = req.query.to ?? today;

  if (!isRealDate(from) || !isRealDate(to) || from > to) {
    return res.status(400).json({
      error: 'invalid_date_range',
      message: 'use from=YYYY-MM-DD&to=YYYY-MM-DD with from <= to',
    });
  }
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 365) {
    return res.status(400).json({
      error: 'range_too_large',
      message: 'ask for at most 366 days at a time',
    });
  }

  res.json(await getAccountUsage(req.user.id, from, to, key.keyId));
});

router.get('/logs', requireUser, async (req, res) => {
  const key = await resolveKeyFilter(req.user.id, req.query.key_id);
  if (!key.ok) return res.status(404).json({ error: 'not_found' });

  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json(await getAccountLogs(req.user.id, key.keyId, limit));
});

module.exports = router;