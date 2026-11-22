// MunchMate: local demo of a microservices + event-driven architecture.
// Zero dependencies. Run: node server.js  ->  http://localhost:3000
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const VERSION = require('./package.json').version;
const uid = () => crypto.randomBytes(3).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms).unref());
const down = {}; // failure simulation switches: payments, delivery, notify, jobs, cache

// ---------- Live activity log (shown in "Behind the scenes") ----------
const logClients = new Set(), logs = [];
function log(svc, msg, kind = 'info') {
  const e = { t: new Date().toTimeString().slice(0, 8), svc, msg, kind };
  logs.push(e); if (logs.length > 150) logs.shift();
  for (const r of logClients) r.write(`data: ${JSON.stringify(e)}\n\n`);
  console.log(`[${e.t}] ${svc}: ${msg}`);
}

// ---------- Redis-style cache (cache-aside, TTL) ----------
const cache = { m: new Map(), hits: 0, misses: 0,
  get(k) { const e = !down.cache && this.m.get(k); if (e && e.exp > Date.now()) { this.hits++; return e.v; } this.misses++; },
  set(k, v, ttl = 30000) { if (!down.cache) this.m.set(k, { v, exp: Date.now() + ttl }); } };

// ---------- SNS topic + SQS queues (with retries and dead-letter queue) ----------
class Queue {
  constructor(name, svc, handler) { Object.assign(this, { name, svc, handler, items: [], dlq: [], busy: false, warned: false }); }
  push(m) { this.items.push({ m, tries: 0 }); this.run(); }
  async run() {
    if (this.busy) return; this.busy = true;
    while (this.items.length) {
      if (down[this.svc]) { if (!this.warned) { log('SQS:' + this.name, `consumer is down, ${this.items.length} message(s) waiting in queue`, 'warn'); this.warned = true; } await sleep(1500); continue; }
      this.warned = false;
      const it = this.items.shift();
      try { await sleep(300); await this.handler(it.m); }
      catch (e) {
        if (++it.tries >= 3) { this.dlq.push(it.m); log('SQS:' + this.name, `${it.m.type} moved to dead-letter queue (${e.message})`, 'error'); }
        else { log('SQS:' + this.name, `retry ${it.tries} for ${it.m.type}: ${e.message}`, 'warn'); this.items.push(it); await sleep(1500); }
      }
    }
    this.busy = false;
  }
}
const bus = { subs: [], publish(evt) {
  log('SNS', `published ${evt.type}${evt.status ? ' (' + evt.status + ')' : ''} for ${evt.orderId}`, 'event');
  for (const s of this.subs) if (s.types.includes(evt.type)) s.q.push(evt); } };

// ---------- Order live updates (server-sent events) ----------
const orderClients = new Map();
const pushOrder = o => { for (const r of orderClients.get(o.id) || []) r.write(`data: ${JSON.stringify(o)}\n\n`); };

// ---------- Users service ----------
const Users = { tokens: new Map(), login(name) {
  const token = uid() + uid(); this.tokens.set(token, { name: (name || 'Guest').slice(0, 30) });
  log('users', `login: ${name || 'Guest'}`); return token; } };

// ---------- Catalog service (cache-aside) ----------
const MENU = [
  { id: 1, name: 'Chicken Biryani', price: 450, emoji: '🍛' }, { id: 2, name: 'Zinger Burger', price: 520, emoji: '🍔' },
  { id: 3, name: 'Seekh Kebab Roll', price: 380, emoji: '🌯' }, { id: 4, name: 'Chicken Karahi', price: 1400, emoji: '🍲' },
  { id: 5, name: 'Margherita Pizza', price: 990, emoji: '🍕' }, { id: 6, name: 'Crispy Fries', price: 220, emoji: '🍟' },
  { id: 7, name: 'Mango Lassi', price: 180, emoji: '🥭' }, { id: 8, name: 'Gulab Jamun', price: 250, emoji: '🍮' }];
const Catalog = { menu() {
  const c = cache.get('menu'); if (c) { log('catalog', 'menu served from Redis cache', 'cache'); return c; }
  log('catalog', 'cache miss: menu read from catalog database (DynamoDB)'); cache.set('menu', MENU); return MENU; } };

// ---------- Payments service ----------
const Payments = { charges: new Map(), async charge(orderId, amount) {
  await sleep(600); if (down.payments) throw new Error('payment provider unreachable');
  this.charges.set(orderId, amount); log('payments', `charged Rs ${amount} for ${orderId}`); } };

// ---------- Orders service ----------
const Orders = { db: new Map(),
  set(o, status, note) { o.status = status; o.history.push({ status, note, t: Date.now() }); pushOrder(o); },
  async place(user, items) {
    const menu = Catalog.menu(), lines = []; let total = 0;
    for (const { id, qty } of items || []) { const m = menu.find(x => x.id === id); if (m && qty > 0) { lines.push({ name: m.name, qty, price: m.price }); total += m.price * qty; } }
    if (!lines.length) throw { code: 400, msg: 'Your cart is empty' };
    const o = { id: 'MM-' + uid().toUpperCase(), user: user.name, lines, total, status: 'PENDING', rider: null, history: [], notifications: [], receipt: null };
    this.db.set(o.id, o); this.set(o, 'PENDING', 'Order created'); log('orders', `order ${o.id} created (Rs ${total})`);
    let paid = false;
    for (let i = 1; i <= 2 && !paid; i++) { try { await Payments.charge(o.id, total); paid = true; } catch (e) { log('orders', `payment attempt ${i} failed: ${e.message}`, 'warn'); } }
    if (!paid) throw { code: 502, msg: 'Payment service is unavailable. Your order stays PENDING, please try again later.', order: o };
    this.set(o, 'PLACED', 'Payment confirmed, order placed');
    bus.publish({ type: 'OrderPlaced', orderId: o.id });
    return o;
  } };

// ---------- Delivery service (queue consumer) ----------
const RIDERS = ['Ali', 'Sara', 'Bilal', 'Hina'];
const Delivery = { handle(evt) {
  const rider = RIDERS[Math.floor(Math.random() * RIDERS.length)];
  log('delivery', `received ${evt.type}, starting fulfilment for ${evt.orderId}`);
  (async () => {
    for (const [status, ms] of [['ACCEPTED', 2500], ['PREPARING', 3000], ['RIDER_ASSIGNED', 3000], ['PICKED_UP', 3500], ['DELIVERED', 4000]]) {
      await sleep(ms); while (down.delivery) await sleep(1000);
      bus.publish({ type: 'StatusChanged', orderId: evt.orderId, status, rider: status === 'ACCEPTED' || status === 'PREPARING' ? null : rider });
    }
  })();
} };

// ---------- Queue consumers: orders-status, Lambda notify, Lambda jobs ----------
const TEXT = { PLACED: 'We received your order', ACCEPTED: 'The restaurant accepted your order', PREPARING: 'Your food is being prepared',
  RIDER_ASSIGNED: 'A rider has been assigned', PICKED_UP: 'Your rider picked up the order', DELIVERED: 'Delivered. Enjoy your meal!' };
const qDelivery = new Queue('delivery', 'delivery', e => Delivery.handle(e));
const qStatus = new Queue('orders-status', 'orders', e => {
  const o = Orders.db.get(e.orderId); if (!o) return; if (e.rider) o.rider = e.rider; Orders.set(o, e.status, TEXT[e.status]); });
const qNotify = new Queue('notify', 'notify', e => {
  const o = Orders.db.get(e.orderId); if (!o) return; const msg = TEXT[e.status || 'PLACED'];
  o.notifications.push({ msg, t: Date.now() }); pushOrder(o); log('lambda:notify', `push/SMS to ${o.user}: "${msg}"`); });
const qJobs = new Queue('jobs', 'jobs', e => {
  const o = Orders.db.get(e.orderId); if (!o) return;
  o.receipt = `Receipt ${o.id}\n` + o.lines.map(l => `${l.qty} x ${l.name}  Rs ${l.qty * l.price}`).join('\n') + `\nTotal Rs ${o.total}`;
  pushOrder(o); log('lambda:jobs', `receipt saved to S3: receipts/${o.id}.txt`); });
bus.subs.push({ q: qDelivery, types: ['OrderPlaced'] }, { q: qJobs, types: ['OrderPlaced'] },
  { q: qNotify, types: ['OrderPlaced', 'StatusChanged'] }, { q: qStatus, types: ['StatusChanged'] });
const QUEUES = [qDelivery, qJobs, qNotify, qStatus];

// ---------- API Gateway (auth, rate limit, routing) ----------
const hits = new Map();
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sse = res => { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write('\n'); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (p === '/health') return send(res, 200, { status: 'ok' });
  if (p === '/api/version') return send(res, 200, { version: VERSION });
  if (!p.startsWith('/api/')) {
    const f = path.join(__dirname, 'public', p === '/' ? 'index.html' : p);
    if (f.startsWith(path.join(__dirname, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(f)); }
    res.writeHead(404); return res.end('Not found');
  }
  const ip = req.socket.remoteAddress, now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 10000); h.push(now); hits.set(ip, h);
  if (h.length > 120) return send(res, 429, { msg: 'Too many requests (gateway throttling)' });
  try {
    if (p === '/api/events') { sse(res); logs.forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`)); logClients.add(res); return req.on('close', () => logClients.delete(res)); }
    if (p === '/api/system') return send(res, 200, { down, cache: { hits: cache.hits, misses: cache.misses }, queues: QUEUES.map(q => ({ name: q.name, waiting: q.items.length, dlq: q.dlq.length })) });
    if (p === '/api/admin/fail' && req.method === 'POST') { const b = await body(req); down[b.service] = !!b.down; log('admin', `${b.service} ${b.down ? 'BROKEN (simulated failure)' : 'recovered'}`, b.down ? 'error' : 'info'); return send(res, 200, { down }); }
    if (p === '/api/login' && req.method === 'POST') { const b = await body(req); return send(res, 200, { token: Users.login(b.name) }); }
    const user = Users.tokens.get(req.headers['x-token'] || url.searchParams.get('token'));
    if (!user) return send(res, 401, { msg: 'Please log in first' });
    if (p === '/api/menu') return send(res, 200, Catalog.menu());
    if (p === '/api/orders' && req.method === 'POST') { const b = await body(req); return send(res, 201, await Orders.place(user, b.items)); }
    const m = p.match(/^\/api\/orders\/([\w-]+)(\/stream)?$/);
    if (m) { const o = Orders.db.get(m[1]); if (!o) return send(res, 404, { msg: 'Order not found' });
      if (!m[2]) return send(res, 200, o);
      sse(res); res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (!orderClients.has(o.id)) orderClients.set(o.id, new Set()); orderClients.get(o.id).add(res);
      return req.on('close', () => orderClients.get(o.id).delete(res)); }
    send(res, 404, { msg: 'Unknown route' });
  } catch (e) { send(res, e.code || 500, { msg: e.msg || e.message, order: e.order }); }
});
if (require.main === module) server.listen(PORT, () => log('gateway', `MunchMate v${VERSION} running at http://localhost:${PORT}`));
module.exports = { server, Catalog, Orders, Payments, cache, down, VERSION };
