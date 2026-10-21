const test = require("node:test");
const assert = require("node:assert/strict");

const poolPath = require.resolve("../src/db/pool");
const orderPath = require.resolve("../src/services/order.service");
const invoicePath = require.resolve("../src/services/invoice.service");

function setup({ failedUpdate } = {}) {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes("FROM payments")) return { rowCount: 1, rows: [{ id: "payment-id", invoice_id: "invoice-id", reference: "expected-ref", amount_kobo: 125000, status: "pending", order_id: "order-id", amount_ngn: 1250, invoice_status: "unpaid", order_status: "pending_payment" }] };
      if (sql.startsWith("UPDATE payments") && !sql.includes("RETURNING")) return { rowCount: 1, rows: [] };
      if (sql.includes("FROM orders") && sql.includes("FOR UPDATE")) return { rowCount: 1, rows: [{ id: "order-id", status: "pending_payment" }] };
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
  delete require.cache[require.resolve("../src/services/paystack.service")];
  process.env.PAYSTACK_SECRET_KEY = "test-only-placeholder";
  global.fetch = async () => ({ ok: true, json: async () => ({ status: true, data: { id: 42, reference: "expected-ref", amount: 125000, currency: "NGN", status: "success" } }) });
  return { service: require("../src/services/paystack.service"), calls };
}

test("successful Paystack verification atomically confirms payment, invoice, and order", async () => {
  const { service, calls } = setup();
  const result = await service.verifyPayment("expected-ref");
  assert.equal(result.body.paymentStatus, "success");
  assert.equal(result.body.orderStatus, "payment_confirmed");
  assert.ok(calls.includes("COMMIT"));
  assert.ok(!calls.includes("ROLLBACK"));
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
