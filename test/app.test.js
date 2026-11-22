const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { server, Catalog, Orders, cache, down, VERSION } = require('../server.js');
let base;
before(async () => { await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port; });
after(() => { server.closeAllConnections?.(); server.close(); });

test('catalog returns the menu with valid prices', () => {
  const menu = Catalog.menu();
  assert.strictEqual(menu.length, 8);
  assert.ok(menu.every(m => m.price > 0 && m.name));
});
test('menu is served from cache on the second read', () => {
  cache.m.clear(); const h = cache.hits; Catalog.menu(); Catalog.menu();
  assert.strictEqual(cache.hits, h + 1);
});
test('placing an order calculates the total and marks it PLACED', async () => {
  const o = await Orders.place({ name: 'Test' }, [{ id: 1, qty: 2 }, { id: 7, qty: 1 }]);
  assert.strictEqual(o.total, 450 * 2 + 180);
  assert.strictEqual(o.status, 'PLACED');
});
test('an empty cart is rejected', async () => {
  await assert.rejects(() => Orders.place({ name: 'Test' }, []), { code: 400 });
});
test('if payment is down the order stays PENDING', async () => {
  down.payments = true;
  try { await assert.rejects(() => Orders.place({ name: 'Test' }, [{ id: 2, qty: 1 }]), e => e.code === 502 && e.order.status === 'PENDING'); }
  finally { down.payments = false; }
});
test('GET /health returns ok', async () => {
  const r = await fetch(base + '/health'); assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), { status: 'ok' });
});
test('GET /api/version returns the package version', async () => {
  assert.deepStrictEqual(await (await fetch(base + '/api/version')).json(), { version: VERSION });
});
test('gateway rejects menu requests without a token', async () => {
  assert.strictEqual((await fetch(base + '/api/menu')).status, 401);
});
test('login then menu works through the gateway', async () => {
  const { token } = await (await fetch(base + '/api/login', { method: 'POST', body: '{"name":"T"}' })).json();
  const menu = await (await fetch(base + '/api/menu', { headers: { 'x-token': token } })).json();
  assert.strictEqual(menu.length, 8);
});
