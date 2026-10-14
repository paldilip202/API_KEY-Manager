const crypto = require('crypto');
const redis = require('./redis');

const COOKIE_NAME = 'sid';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const sessionKey = (sid) =>
  'sess:' + crypto.createHash('sha256').update(sid).digest('hex');

async function createSession(userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  await redis.set(sessionKey(sid), userId, 'EX', SESSION_TTL_SECONDS);
  return sid;
}

async function getSessionUserId(sid) {
  return redis.get(sessionKey(sid));
}

async function destroySession(sid) {
  await redis.del(sessionKey(sid));
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSession,
  getSessionUserId,
  destroySession,
};