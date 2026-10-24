const test = require("node:test");
const assert = require("node:assert/strict");

const poolPath = require.resolve("../src/db/pool");
const orderPath = require.resolve("../src/services/order.service");
const invoicePath = require.resolve("../src/services/invoice.service");
const chordPath = require.resolve("../src/services/chord.service");

function setup({ failedUpdate, paymentOverrides = {}, failNotification = false, stock = 5, quantity = 2 } = {}) {
  const calls = [];
  const statements = [];
  const notifications = [];
  const state = { stock };
  const client = {
    async query(sql, params = []) {
      statements.push(sql);
      calls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes("FROM payments")) return { rowCount: 1, rows: [{ id: "payment-id", invoice_id: "invoice-id", reference: "expected-ref", amount_kobo: 125000, status: "pending", order_id: "order-id", amount_ngn: 1250, invoice_status: "unpaid", order_ref: "PH-1", order_status: "pending_payment", ...paymentOverrides }] };
      if (sql.startsWith("UPDATE payments") && !sql.includes("RETURNING")) return { rowCount: 1, rows: [] };
      if (sql.includes("FROM orders") && sql.includes("FOR UPDATE")) return { rowCount: 1, rows: [{ id: "order-id", status: "pending_payment" }] };
      if (sql.includes("FROM order_items")) return { rowCount: 1, rows: [{ product_id: "med-1", quantity }] };
      if (sql.includes("FROM inventory") && sql.includes("FOR UPDATE")) return { rowCount: 1, rows: [{ id: "med-1", name: "Medicine", stock: state.stock, low_stock_threshold: 1, low_stock_alerted: false }] };
      if (sql.startsWith("UPDATE inventory")) { state.stock -= Number(params[0]); return { rowCount: 1, rows: [{ id: "med-1", name: "Medicine", stock: state.stock, low_stock_threshold: 1 }] }; }
      if (sql.includes("UPDATE payments")) return { rowCount: failedUpdate === "payment" ? 0 : 1, rows: [{ id: "payment-id" }] };
      if (sql.includes("UPDATE invoices")) return { rowCount: failedUpdate === "invoice" ? 0 : 1, rows: [{ id: "invoice-id" }] };
      if (sql.includes("UPDATE orders")) return { rowCount: failedUpdate === "order" ? 0 : 1, rows: [{ id: "order-id" }] };
      return { rowCount: 0, rows: [] };
    },
    release() { calls.push("RELEASE"); }
  };
  const pool = {
    async query(sql) {
      return client.query(sql);
    },
    async connect() { return client; }
  };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  require.cache[orderPath] = { id: orderPath, filename: orderPath, loaded: true, exports: {} };
  require.cache[invoicePath] = { id: invoicePath, filename: invoicePath, loaded: true, exports: {} };
  require.cache[chordPath] = { id: chordPath, filename: chordPath, loaded: true, exports: { sendNotification: async (...args) => { calls.push("NOTIFY"); notifications.push(args); if (failNotification) throw new Error("Chord unavailable"); } } };
  delete require.cache[require.resolve("../src/services/paystack.service")];
  process.env.PAYSTACK_SECRET_KEY = "test-only-placeholder";
  global.fetch = async () => ({ ok: true, json: async () => ({ status: true, data: { id: 42, reference: "expected-ref", amount: 125000, currency: "NGN", status: "success" } }) });
  return { service: require("../src/services/paystack.service"), calls, notifications, statements, state };
}

test("duplicate successful verification is idempotent and performs no writes", async () => {
  const { service, calls, state } = setup({ stock: 3, paymentOverrides: { status: "success", invoice_status: "paid", order_status: "ready_for_pickup" } });
  let paystackCalls = 0;
  global.fetch = async () => { paystackCalls++; throw new Error("duplicate must not need another provider request"); };
  const result = await service.verifyPayment("expected-ref");
  assert.equal(result.body.orderStatus, "ready_for_pickup");
  assert.equal(paystackCalls, 0);
  assert.equal(state.stock, 3);
  assert.deepEqual(calls, ["SELECT p.id, p.invoice_id,"]);
});

for (const [field, transaction] of [
  ["amount", { amount: 1 }],
  ["currency", { currency: "USD" }]
]) {
  test(`webhook verification ${field} mismatch does not update payment records`, async () => {
    const { service, calls } = setup();
    global.fetch = async () => ({ ok: true, json: async () => ({ status: true, data: { id: 42, reference: "expected-ref", amount: 125000, currency: "NGN", status: "success", ...transaction } }) });
    const result = await service.verifyPayment("expected-ref", { recordFailure: false });
    assert.equal(result.error.status, 409);
    assert.ok(!calls.some(call => call.startsWith("UPDATE")));
  });
}

test("successful Paystack verification deducts stock once and atomically confirms payment, invoice, and order", async () => {
  const { service, calls, notifications, statements, state } = setup();
  const result = await service.verifyPayment("expected-ref");
  assert.equal(result.body.paymentStatus, "success");
  assert.equal(result.body.orderStatus, "payment_confirmed");
  assert.equal(state.stock, 3);
  assert.ok(calls.includes("COMMIT"));
  assert.ok(!calls.includes("ROLLBACK"));
  assert.match(statements[0], /o\.order_ref/);
  assert.deepEqual(notifications, [["payment_confirmed", "PH-1"]]);
  assert.ok(calls.indexOf("COMMIT") < calls.indexOf("NOTIFY"));
});

test("failed Paystack verification leaves inventory unchanged", async () => {
  const { service, state } = setup();
  global.fetch = async () => ({ ok: true, json: async () => ({ status: true, data: { id: 42, reference: "expected-ref", amount: 125000, currency: "NGN", status: "failed" } }) });
  const result = await service.verifyPayment("expected-ref");
  assert.equal(result.error.status, 409);
  assert.equal(state.stock, 5);
});

test("successful payment cannot oversell inventory changed before verification", async () => {
  const { service, state, calls } = setup({ stock: 1, quantity: 2 });
  const result = await service.verifyPayment("expected-ref");
  assert.equal(result.error.body.error, "INSUFFICIENT_STOCK_AFTER_PAYMENT");
  assert.equal(state.stock, 1);
  assert.ok(calls.includes("ROLLBACK"));
  assert.ok(!calls.includes("COMMIT"));
});

test("payment notification failure does not change the committed payment result", async () => {
  const { service } = setup({ failNotification: true });
  const result = await service.verifyPayment("expected-ref");
  assert.equal(result.body.paymentStatus, "success");
  assert.equal(result.body.orderStatus, "payment_confirmed");
});

for (const [field, transaction] of [
  ["amount", { amount: 1 }],
  ["currency", { currency: "USD" }],
  ["reference", { reference: "wrong-ref" }],
  ["status", { status: "failed" }]
]) {
  test(`verification rejects mismatched ${field} without updating invoice or order`, async () => {
    const { service, calls } = setup();
    global.fetch = async () => ({ ok: true, json: async () => ({ status: true, data: { id: 42, reference: "expected-ref", amount: 125000, currency: "NGN", status: "success", ...transaction } }) });
    const result = await service.verifyPayment("expected-ref");
    assert.equal(result.error.status, 409);
    assert.ok(!calls.some(call => call.startsWith("BEGIN")));
  });
}

for (const field of ["payment", "invoice", "order"]) {
  test(`verification rolls back when ${field} update affects no record`, async () => {
    const { service, calls } = setup({ failedUpdate: field });
    await assert.rejects(service.verifyPayment("expected-ref"));
    assert.ok(calls.includes("ROLLBACK"));
    assert.ok(!calls.includes("COMMIT"));
    assert.ok(calls.includes("RELEASE"));
  });
}
