const test = require("node:test");
const assert = require("node:assert/strict");

function loadRoutes({ rows = [], orderStatus = "payment_confirmed", invoiceStatus = "paid", failNotification = false } = {}) {
  const poolPath = require.resolve("../src/db/pool");
  const orderPath = require.resolve("../src/services/order.service");
  const invoicePath = require.resolve("../src/services/invoice.service");
  const chordPath = require.resolve("../src/services/chord.service");
  const routePath = require.resolve("../src/routes/pharmacy");
  const queries = [];
  const transaction = [];
  const notifications = [];
  const client = {
    async query(sql) {
      transaction.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes("FROM orders") && sql.includes("FOR UPDATE")) return { rowCount: 1, rows: [{ id: "order-id", order_ref: "PH-1", status: orderStatus }] };
      if (sql.includes("FROM invoices") && sql.includes("FOR UPDATE")) return invoiceStatus ? { rowCount: 1, rows: [{ status: invoiceStatus }] } : { rowCount: 0, rows: [] };
      if (sql.startsWith("UPDATE orders")) return { rowCount: 1, rows: [{ order_ref: "PH-1", status: "ready_for_pickup", updated_at: new Date(0) }] };
      return { rowCount: 1, rows: [] };
    },
    release() { transaction.push("RELEASE"); }
  };
  const pool = {
    async query(sql, params) { queries.push({ sql, params }); return { rowCount: rows.length, rows }; },
    async connect() { return client; }
  };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  require.cache[orderPath] = { id: orderPath, filename: orderPath, loaded: true, exports: { getOrderWithItems: async (_db, ref) => ({ order: { orderRef: ref, status: "pending_payment", items: [] } }) } };
  require.cache[invoicePath] = { id: invoicePath, filename: invoicePath, loaded: true, exports: { getInvoiceForOrder: async () => ({ invoice_ref: "INV-1", amount_ngn: 200, status: "unpaid", paid_at: null }) } };
  require.cache[chordPath] = { id: chordPath, filename: chordPath, loaded: true, exports: { sendNotification: async (...args) => { transaction.push("NOTIFY"); notifications.push(args); if (failNotification) throw new Error("Chord unavailable"); } } };
  delete require.cache[routePath];
  const router = require(routePath);
  const getHandler = router.stack.find(layer => layer.route?.path === "/orders" && layer.route.methods.get).route.stack[0].handle;
  const patchHandler = router.stack.find(layer => layer.route?.path === "/orders/:id/status" && layer.route.methods.patch).route.stack[0].handle;
  return { getHandler, patchHandler, queries, transaction, notifications };
}

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

for (const filter of ["all", "pending_payment", "payment_confirmed", "ready_for_pickup"]) {
  test(`pharmacist listing accepts ${filter} filter`, async () => {
    const { getHandler, queries } = loadRoutes({ rows: [{ id: "order-id", order_ref: "PH-1" }] });
    const res = response();
    await getHandler({ query: { status: filter } }, res, error => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.count, 1);
    if (filter === "all") assert.match(queries[0].sql, /status IN \('pending_payment', 'payment_confirmed', 'ready_for_pickup'\)/);
    else assert.deepEqual(queries[0].params, [filter]);
  });
}

test("pharmacist listing rejects unsupported status filters", async () => {
  const { getHandler, queries } = loadRoutes();
  const res = response();
  await getHandler({ query: { status: "rejected" } }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "INVALID_STATUS_FILTER");
  assert.equal(queries.length, 0);
});

test("paid payment_confirmed order can transition to ready_for_pickup and notify after commit", async () => {
  const { patchHandler, transaction, notifications } = loadRoutes();
  const res = response();
  await patchHandler({ params: { id: "PH-1" }, body: { status: "ready_for_pickup" } }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "ready_for_pickup");
  assert.ok(transaction.includes("COMMIT"));
  assert.ok(transaction.indexOf("COMMIT") < transaction.indexOf("NOTIFY"));
  assert.deepEqual(notifications, [["ready_for_pickup", "PH-1"]]);
});

test("pickup notification failure does not undo the committed status update", async () => {
  const { patchHandler, transaction } = loadRoutes({ failNotification: true });
  const res = response();
  await patchHandler({ params: { id: "PH-1" }, body: { status: "ready_for_pickup" } }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "ready_for_pickup");
  assert.ok(transaction.includes("COMMIT"));
});

test("unpaid invoice cannot transition an otherwise payment_confirmed order", async () => {
  const { patchHandler, transaction } = loadRoutes({ invoiceStatus: "unpaid" });
  const res = response();
  await patchHandler({ params: { id: "PH-1" }, body: { status: "ready_for_pickup" } }, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "PAYMENT_NOT_CONFIRMED");
  assert.ok(transaction.includes("ROLLBACK"));
  assert.ok(!transaction.some(q => q.startsWith("UPDATE orders")));
});

test("pending_payment order cannot transition to ready_for_pickup", async () => {
  const { patchHandler, transaction } = loadRoutes({ orderStatus: "pending_payment" });
  const res = response();
  await patchHandler({ params: { id: "PH-1" }, body: { status: "ready_for_pickup" } }, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "INVALID_STATUS_TRANSITION");
  assert.ok(transaction.includes("ROLLBACK"));
});

test("unsupported pharmacist transition is rejected", async () => {
  const { patchHandler, transaction } = loadRoutes();
  const res = response();
  await patchHandler({ params: { id: "PH-1" }, body: { status: "rejected" } }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "INVALID_TARGET_STATUS");
  assert.equal(transaction.length, 0);
});
