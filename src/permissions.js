const PERMISSIONS = {
  models: ['/v1/models'],
  chat: ['/v1/chat/*'],
};

function scopesFromPermissions(names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  const scopes = [];
  for (const name of names) {
    if (!Object.hasOwn(PERMISSIONS, name)) return null;
    scopes.push(...PERMISSIONS[name]);
  }
  return [...new Set(scopes)];
}

function permissionsFromScopes(scopes) {
  return Object.keys(PERMISSIONS).filter((name) =>
    PERMISSIONS[name].every((pattern) => scopes.includes(pattern))
  );
}

module.exports = { scopesFromPermissions, permissionsFromScopes };