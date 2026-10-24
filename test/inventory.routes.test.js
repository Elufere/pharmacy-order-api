const test = require("node:test");
const assert = require("node:assert/strict");

function response() { return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
function loadRoutes(pool, notifications = []) {
  const poolPath = require.resolve("../src/db/pool"), chordPath = require.resolve("../src/services/chord.service"), routePath = require.resolve("../src/routes/inventory");
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  require.cache[chordPath] = { id: chordPath, filename: chordPath, loaded: true, exports: { sendNotification: async (...args) => notifications.push(args) } };
  delete require.cache[routePath];
  const router = require(routePath);
  const create = router.stack.find(layer => layer.route?.path === "/" && layer.route.methods.post).route.stack.at(-1).handle;
  const topUp = router.stack.find(layer => layer.route?.path === "/:id/top-up" && layer.route.methods.post).route.stack.at(-1).handle;
  return { create, topUp };
}
const authorized = { header: name => name === "x-pharmacy-api-key" ? "test-key" : undefined };

test("authorized pharmacy can add an inventory item; duplicate identifiers conflict", async () => {
  let exists = false;
  const { create } = loadRoutes({ async query(_sql, params) { assert.equal(params[0], "med-new"); if (exists) return { rowCount: 0, rows: [] }; exists = true; return { rowCount: 1, rows: [{ id: "med-new", name: "New medicine", unit: "pack", price_ngn: 100, stock: 5, low_stock_threshold: 2, low_stock_alerted: false }] }; } });
  process.env.PHARMACY_API_KEY = "test-key";
  const req = { ...authorized, body: { id: "med-new", name: "New medicine", unit: "pack", priceNgn: 100, stock: 5, lowStockThreshold: 2 } };
  const first = response(); await create(req, first, error => { throw error; });
  assert.equal(first.statusCode, 201); assert.equal(first.body.stock, 5);
  const second = response(); await create(req, second, error => { throw error; });
  assert.equal(second.statusCode, 409); assert.equal(second.body.error, "DUPLICATE_MEDICINE");
});

test("inventory creation rejects negative or fractional stock, threshold, and prices", async () => {
  const { create } = loadRoutes({ async query() { throw new Error("invalid request reached database"); } });
  for (const patch of [{ stock: -1 }, { priceNgn: 1.5 }, { lowStockThreshold: -1 }]) {
    const res = response(); await create({ ...authorized, body: { id: "m", name: "M", unit: "box", priceNgn: 10, stock: 1, lowStockThreshold: 2, ...patch } }, res, error => { throw error; });
    assert.equal(res.statusCode, 400);
  }
});

test("top-up increments current stock atomically and rejects non-positive quantity", async () => {
  let stock = 4;
  const { topUp } = loadRoutes({ async query(sql, params) { assert.match(sql, /stock = stock \+ \$1/); stock += params[0]; return { rowCount: 1, rows: [{ id: "med-1", name: "Medicine", stock, low_stock_threshold: 2, low_stock_alerted: false }] }; } });
  const bad = response(); await topUp({ ...authorized, params: { id: "med-1" }, body: { quantity: 0 } }, bad, error => { throw error; });
  assert.equal(bad.statusCode, 400);
  const good = response(); await topUp({ ...authorized, params: { id: "med-1" }, body: { quantity: 3 } }, good, error => { throw error; });
  assert.equal(good.statusCode, 200); assert.equal(good.body.stock, 7);
});
