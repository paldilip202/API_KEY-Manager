require('dotenv').config();
const express = require('express');
const { createKey, listKeys, revokeKey } = require('./keys');
const { authenticate } = require('./auth');
const { requireScope } = require('./scopes');
const { rateLimit } = require('./rateLimit');
const { requestLogger } = require('./logger');
const { getRecentLogs, getUsage } = require('./usage');
const { quotaAlert } = require('./quota');

const app = express();
app.use(express.json());
app.use(requestLogger);

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  if (header !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'admin_auth_required' });
  }
  next();
}

app.post('/admin/keys', requireAdmin, async (req, res) => {
  const { name, scopes, rateLimitPerMin, expiresAt, monthlyQuota, webhookUrl } = req.body;
  if (!name || !Array.isArray(scopes) || scopes.length === 0) {
    return res.status(400).json({ error: 'name and scopes[] are required' });
  }

  let expiry = null;
  if (expiresAt) {
    expiry = new Date(expiresAt);
    if (isNaN(expiry.getTime()) || expiry <= new Date()) {
      return res.status(400).json({
        error: 'invalid_expires_at',
        message: 'expiresAt must be a future ISO date-time, like 2026-12-31T23:59:59Z',
      });
    }
  }

  if (monthlyQuota !== undefined && (!Number.isInteger(monthlyQuota) || monthlyQuota <= 0)) {
    return res.status(400).json({ error: 'invalid_monthly_quota' });
  }
  if (webhookUrl !== undefined && !isHttpUrl(webhookUrl)) {
    return res.status(400).json({ error: 'invalid_webhook_url' });
  }

  const created = await createKey({
    name,
    scopes,
    rateLimitPerMin: rateLimitPerMin || 100,
    expiresAt: expiry,
    monthlyQuota,
    webhookUrl,
  });
  res.status(201).json(created);
});

app.get('/admin/keys', requireAdmin, async (req, res) => {
  res.json(await listKeys());
});

app.delete('/admin/keys/:id', requireAdmin, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const revoked = await revokeKey(req.params.id);
  if (!revoked) return res.status(404).json({ error: 'not_found_or_already_revoked' });
  res.json({ revoked: true });
});

app.get('/read/hello', authenticate, rateLimit, requireScope, quotaAlert, (req, res) => {
  res.json({ message: 'hello from read', keyName: req.apiKey.name });
});

app.post('/write/hello', authenticate, rateLimit, requireScope, quotaAlert, (req, res) => {
  res.json({ message: 'hello from write', keyName: req.apiKey.name });
});

app.get('/admin/keys/:id/logs', requireAdmin, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json(await getRecentLogs(req.params.id, limit));
});

app.get('/admin/keys/:id/usage', requireAdmin, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const from = req.query.from || weekAgo;
  const to = req.query.to || today;

  if (!dateRe.test(from) || !dateRe.test(to) || from > to) {
    return res.status(400).json({
      error: 'invalid_date_range',
      message: 'use from=YYYY-MM-DD&to=YYYY-MM-DD with from <= to',
    });
  }

  res.json(await getUsage(req.params.id, from, to));
});

module.exports = app;