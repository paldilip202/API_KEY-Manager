const pool = require('./db');
const { COOKIE_NAME, getSessionUserId } = require('./sessions');

async function requireUser(req, res, next) {
  try {
    const sid = req.cookies?.[COOKIE_NAME];
    if (!sid) return res.status(401).json({ error: 'login_required' });

    const userId = await getSessionUserId(sid);
    if (!userId) return res.status(401).json({ error: 'session_invalid' });

    const { rows } = await pool.query(
      'SELECT id, email, plan, created_at FROM users WHERE id = $1',
      [userId]
    );
    if (!rows[0]) return res.status(401).json({ error: 'session_invalid' });

    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireUser };