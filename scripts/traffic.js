// Usage: node scripts/traffic.js [email] [password] [chatCount]
// Logs in as a dashboard user, creates a fresh "traffic simulator" key,
// and sends a mix of good and bad requests so the Usage page has data to show.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const [email = 'meera@example.com', password = 'correct-horse-battery', countArg = '20'] =
  process.argv.slice(2);
const chatCount = Math.max(1, parseInt(countArg, 10) || 20);

const MODELS = ['dummy-small', 'dummy-medium', 'dummy-large'];

async function api(method, path, { cookie, key, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, res };
}

async function main() {
  const login = await api('POST', '/api/login', { body: { email, password } });
  if (login.status !== 200) {
    console.error(`Login failed (${login.status}): ${login.json?.error}`);
    process.exit(1);
  }
  const cookie = login.res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

  // Revoke older simulator keys so the account never hits its key limit.
  const list = await api('GET', '/api/keys', { cookie });
  for (const k of Array.isArray(list.json) ? list.json : []) {
    if (k.name === 'traffic simulator' && !k.revoked_at) {
      await api('DELETE', `/api/keys/${k.id}`, { cookie });
    }
  }

  const created = await api('POST', '/api/keys', {
    cookie,
    body: { name: 'traffic simulator', permissions: ['models', 'chat'] },
  });
  if (created.status !== 201) {
    console.error(
      `Could not create a key (${created.status}): ${created.json?.error} ${created.json?.message || ''}`
    );
    process.exit(1);
  }
  const key = created.json.key;

  const tally = {};
  const count = (status) => {
    tally[status] = (tally[status] || 0) + 1;
  };

  for (let i = 1; i <= chatCount; i++) {
    const r = await api('POST', '/v1/chat/completions', {
      key,
      body: {
        model: MODELS[i % 3],
        messages: [{ role: 'user', content: `Question number ${i} about API keys` }],
      },
    });
    count(r.status);
  }
  for (let i = 0; i < 5; i++) {
    count((await api('GET', '/v1/models', { key })).status);
  }
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', '/v1/chat/completions', {
      key,
      body: { model: 'nope', messages: [{ role: 'user', content: 'hi' }] },
    });
    count(r.status);
  }
  for (let i = 0; i < 2; i++) {
    count((await api('GET', '/v1/embeddings', { key })).status);
  }

  console.log(`Logged in as ${email}.`);
  console.log(`Created the key "traffic simulator" (${key.slice(0, 12)}...).`);
  console.log('Status codes returned:', tally);
  console.log('Now open the Usage page in the dashboard and click Refresh.');
}

main().catch((err) => {
  console.error(`traffic script failed: ${err.message}`);
  console.error(`Is the API running at ${BASE}?`);
  process.exit(1);
});