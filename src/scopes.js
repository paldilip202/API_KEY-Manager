const path = require('path');

function matchesScope(pattern, requestPath) {
  if (pattern.endsWith('/*')) {
    return requestPath.startsWith(pattern.slice(0, -1));
  }
  return requestPath === pattern;
}

function requireScope(req, res, next) {
  const requestPath = path.posix.normalize(req.originalUrl.split('?')[0]);
  const allowed = req.apiKey.scopes.some((pattern) => matchesScope(pattern, requestPath));

  if (!allowed) {
    return res.status(403).json({
      error: 'scope_forbidden',
      message: `This key is not permitted to access ${requestPath}`,
    });
  }
  next();
}

module.exports = { matchesScope, requireScope };