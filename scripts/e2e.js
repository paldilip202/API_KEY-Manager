require('dotenv').config();
const http = require('http');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = {
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
  'Content-Type': 'application/json',
};

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bearer = (key) => ({ Authorization: `Bearer ${key}` });

async function call(method, path, headers = {}, body) {
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
  return { status: res.status, json, headers: res.headers };
}

const createKey = (payload) => call('POST', '/admin/keys', ADMIN, payload);
const read = (key) => call('GET', '/read/hello', bearer(key));
const write = (key) => call('POST', '/write/hello', bearer(key));

async function main() {
  // Rate-limit windows last one minute. Do not start near the end of one.
  const secs = new Date().getUTCSeconds();
  if (secs >= 48) {
    console.log(`(waiting ${61 - secs}s so the rate-limit test stays inside one minute)`);
    await sleep((61 - secs) * 1000);
  }

  // A tiny webhook receiver so we can test the quota alert.
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        // ignore bad bodies
      }
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((resolve) => receiver.listen(4001, resolve));

  console.log('\n-- key management --');
  const a = await createKey({ name: 'e2e main', scopes: ['/read/*'], rateLimitPerMin: 5 });
  check(
    'create key returns 201 and a raw key',
    a.status === 201 && a.json?.key?.startsWith('ak_live_'),
    JSON.stringify(a.json)
  );
  const keyA = a.json?.key;
  const idA = a.json?.id;

  const list = await call('GET', '/admin/keys', ADMIN);
  const listed = Array.isArray(list.json) ? list.json.find((k) => k.id === idA) : null;
  check('list shows the new key', !!listed);
  check(
    'list never exposes key_hash or the full key',
    !!listed && !('key_hash' in listed) && !('key' in listed) && !('webhook_url' in listed)
  );

  console.log('\n-- authentication --');
  const noKey = await call('GET', '/read/hello');
  check('no key -> 401 missing_key', noKey.status === 401 && noKey.json?.error === 'missing_key');
  const fake = await call('GET', '/read/hello', bearer('ak_live_fake'));
  check('fake key -> 401 invalid_key', fake.status === 401 && fake.json?.error === 'invalid_key');

  console.log('\n-- scopes and rate limit (limit = 5 per minute) --');
  const r1 = await read(keyA);
  check('read-scoped key can call /read/hello', r1.status === 200);
  check(
    'rate limit headers are present',
    r1.headers.get('x-ratelimit-limit') === '5' && r1.headers.get('x-ratelimit-remaining') === '4',
    `limit=${r1.headers.get('x-ratelimit-limit')} remaining=${r1.headers.get('x-ratelimit-remaining')}`
  );
  const w1 = await write(keyA);
  check(
    'read-scoped key gets 403 on /write/hello',
    w1.status === 403 && w1.json?.error === 'scope_forbidden'
  );

  const statuses = [];
  let lastRes;
  for (let i = 0; i < 4; i++) {
    lastRes = await read(keyA);
    statuses.push(lastRes.status);
  }
  check(
    'requests 3-5 pass, request 6 gets 429',
    JSON.stringify(statuses) === JSON.stringify([200, 200, 200, 429]),
    `got ${statuses.join(',')}`
  );
  check(
    '429 has rate_limit_exceeded and Retry-After',
    lastRes.status === 429 &&
      lastRes.json?.error === 'rate_limit_exceeded' &&
      !!lastRes.headers.get('retry-after')
  );

  const b = await createKey({ name: 'e2e other', scopes: ['/read/*'], rateLimitPerMin: 100 });
  const rb = await read(b.json?.key);
  check('a different key is not affected (limit is per key)', rb.status === 200);

  console.log('\n-- revocation --');
  const c = await createKey({ name: 'e2e revoke', scopes: ['/read/*'] });
  const keyC = c.json?.key;
  const c1 = await read(keyC);
  check('key works before revoke (and is now cached)', c1.status === 200);
  const t0 = Date.now();
  const del = await call('DELETE', `/admin/keys/${c.json?.id}`, ADMIN);
  const c2 = await read(keyC);
  const elapsed = Date.now() - t0;
  check('revoke returns 200', del.status === 200, JSON.stringify(del.json));
  check('revoked key -> 401 key_revoked', c2.status === 401 && c2.json?.error === 'key_revoked');
  check(`revoked key stopped within 1 second (${elapsed} ms)`, elapsed < 1000);

  console.log('\n-- expiry (takes about 4 seconds) --');
  const d = await createKey({
    name: 'e2e expiry',
    scopes: ['/read/*'],
    expiresAt: new Date(Date.now() + 3000).toISOString(),
  });
  const keyD = d.json?.key;
  check('key with a future expiry is created', d.status === 201, JSON.stringify(d.json));
  check('key works before it expires', (await read(keyD)).status === 200);
  await sleep(3500);
  const d2 = await read(keyD);
  check(
    'expired key -> 401 key_expired (not invalid_key)',
    d2.status === 401 && d2.json?.error === 'key_expired'
  );

  console.log('\n-- input validation --');
  const bad1 = await createKey({ name: 'x', scopes: [] });
  check('empty scopes -> 400', bad1.status === 400);
  const bad2 = await createKey({ name: 'x', scopes: ['/read/*'], expiresAt: '2020-01-01T00:00:00Z' });
  check(
    'past expiry -> 400 invalid_expires_at',
    bad2.status === 400 && bad2.json?.error === 'invalid_expires_at'
  );
  const bad3 = await createKey({ name: 'x', scopes: ['/read/*'], monthlyQuota: -5 });
  check(
    'negative quota -> 400 invalid_monthly_quota',
    bad3.status === 400 && bad3.json?.error === 'invalid_monthly_quota'
  );
  const bad4 = await createKey({ name: 'x', scopes: ['/read/*'], monthlyQuota: 10, webhookUrl: 'not a url' });
  check(
    'bad webhook URL -> 400 invalid_webhook_url',
    bad4.status === 400 && bad4.json?.error === 'invalid_webhook_url'
  );
  const noAdmin = await call('GET', '/admin/keys', bearer('wrong'));
  check('admin endpoints reject a wrong token', noAdmin.status === 401);

  console.log('\n-- quota alert (quota = 10, alert at 8) --');
  const f = await createKey({
    name: 'e2e quota',
    scopes: ['/read/*'],
    monthlyQuota: 10,
    webhookUrl: 'http://localhost:4001/hook',
  });
  const keyF = f.json?.key;
  for (let i = 0; i < 12; i++) {
    await read(keyF);
  }
  await sleep(1500);
  check('exactly one webhook for 12 requests', received.length === 1, `received ${received.length}`);
  check(
    'webhook says used 8 of 10',
    received[0]?.event === 'quota.threshold_reached' &&
      received[0]?.used === 8 &&
      received[0]?.quota === 10
  );

  console.log('\n-- usage dashboard and logs --');
  await sleep(1000);
  const u = await call('GET', `/admin/keys/${idA}/usage`, ADMIN);
  const uj = u.json || {};
  check(
    'today / this month / all-time are all 6',
    uj.today === 6 && uj.this_month === 6 && uj.all_time === 6,
    `today=${uj.today} month=${uj.this_month} all=${uj.all_time}`
  );
  check(
    'range summary: 6 requests, 2 errors',
    uj.range?.requests === 6 && uj.range?.errors === 2,
    JSON.stringify(uj.range)
  );
  check('error rate is 2/6', Math.abs((uj.range?.error_rate ?? -1) - 0.3333) < 0.001);
  check('average latency is a positive number', uj.range?.avg_latency_ms > 0);
  check('daily breakdown has one day', uj.daily?.length === 1);

  const old = await call('GET', `/admin/keys/${idA}/usage?from=2000-01-01&to=2000-01-31`, ADMIN);
  check(
    'an old date range is empty but totals stay',
    old.json?.range?.requests === 0 && old.json?.all_time === 6
  );
  const badRange = await call('GET', `/admin/keys/${idA}/usage?from=2026-10-07&to=2026-10-01`, ADMIN);
  check('reversed date range -> 400', badRange.status === 400);

  const logs = await call('GET', `/admin/keys/${idA}/logs`, ADMIN);
  const rows = Array.isArray(logs.json) ? logs.json : [];
  const codes = rows.map((l) => l.status_code).sort();
  check(
    'logs hold all 6 calls (4 x 200, one 403, one 429)',
    JSON.stringify(codes) === JSON.stringify([200, 200, 200, 200, 403, 429]),
    codes.join(',')
  );
  check(
    'every log row has an endpoint and a numeric latency',
    rows.length > 0 && rows.every((l) => l.endpoint?.startsWith('/') && typeof l.latency_ms === 'number')
  );

  receiver.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`test run crashed: ${err.message}`);
  console.error(`Is the server running at ${BASE}, and is ADMIN_TOKEN set in .env?`);
  process.exit(1);
});