const { hashKey, findKeyByHash } = require('./keys');
const redis = require('./redis');

const CACHE_TTL_SECONDS = 300;

async function getKeyRecord(keyHash) {
  const cached = await redis.get(`key:${keyHash}`);
  if (cached) return JSON.parse(cached);

  const record = await findKeyByHash(keyHash);
  if (!record) return null;

  await redis.set(`key:${keyHash}`, JSON.stringify(record), 'EX', CACHE_TTL_SECONDS);
  return record;
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'missing_key' });
    }

    const record = await getKeyRecord(hashKey(token));
    if (!record) return res.status(401).json({ error: 'invalid_key' });
      req.keyId = record.id;
    if (record.revoked_at) return res.status(401).json({ error: 'key_revoked' });
    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      return res.status(401).json({ error: 'key_expired' });
    }

    req.apiKey = record;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authenticate };