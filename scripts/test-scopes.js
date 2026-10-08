const assert = require('assert');
const { matchesScope } = require('../src/scopes');

assert.strictEqual(matchesScope('/read/*', '/read/hello'), true);
assert.strictEqual(matchesScope('/read/*', '/write/hello'), false);
assert.strictEqual(matchesScope('/read/*', '/readme'), false);
assert.strictEqual(matchesScope('/read/hello', '/read/hello'), true);
assert.strictEqual(matchesScope('/read/hello', '/read/hello2'), false);

console.log('all scope tests passed');