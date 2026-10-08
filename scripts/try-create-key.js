const { createKey } = require('../src/keys');
const pool = require('../src/db');

(async () => {
  const result = await createKey({
    name: 'test key',
    scopes: ['/read/*'],
    rateLimitPerMin: 100,
  });
  console.log(result);
  await pool.end();
})();