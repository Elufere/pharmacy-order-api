const test = require("node:test");
const assert = require("node:assert/strict");

function setup({ verificationStatus = "pending", invoiceStatus = "unpaid" } = {}) {
  const poolPath = require.resolve("../src/db/pool");
  const orderPath = require.resolve("../src/services/order.service");
  const invoicePath = require.resolve("../src/services/invoice.service");
  const chordPath = require.resolve("../src/services/chord.service");
  const state = { attempts: [], invoiceStatus, verificationStatus, lockTail: Promise.resolve(), initRequests: [], statements: [] };
  function activeAttempt(invoiceId) { return state.attempts.find(attempt => attempt.invoiceId === invoiceId && attempt.status === "pending"); }
  const pool = {
    async query(sql, params = []) {
      if (sql.includes("FROM payments p JOIN invoices")) {
        const attempt = state.attempts.find(item => item.reference === params[0]);
        if (!attempt) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ id: attempt.id, invoice_id: "invoice-1", reference: attempt.reference, amount_kobo: 125000, status: attempt.status, order_id: "order-1", amount_ngn: 1250, invoice_status: state.invoiceStatus, order_ref: "PH-1", order_status: "pending_payment" }] };
      }
      if (sql.startsWith("UPDATE payments SET status")) {
        const attempt = state.attempts.find(item => item.id === params[0]);
        if (attempt) attempt.status = params[1];
        return { rowCount: attempt ? 1 : 0, rows: [] };
      }
      if (sql.includes("FROM payments") && sql.includes("status = 'pending'")) {
        const attempt = activeAttempt(params[0]);
        return { rowCount: attempt ? 1 : 0, rows: attempt ? [{ reference: attempt.reference, authorization_url: attempt.url }] : [] };
      }
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
    async connect() {
      let unlock;
      return {
        async query(sql, params = []) {
          state.statements.push(sql);
          if (sql === "BEGIN") return { rowCount: null, rows: [] };
          if (sql.includes("FROM orders") && sql.includes("FOR UPDATE")) {
            const previous = state.lockTail;
            state.lockTail = new Promise(resolve => { unlock = resolve; });
            await previous;
            return { rowCount: 1, rows: [{ id: "order-1", status: "pending_payment" }] };
          }
          if (sql.includes("FROM invoices i JOIN orders o") && sql.includes("FOR UPDATE OF i")) return { rowCount: 1, rows: [{ id: "invoice-1", invoice_ref: "INV-1", order_id: "order-1", order_ref: "PH-1", amount_ngn: 1250, status: state.invoiceStatus }] };
          if (sql.includes("FROM payments") && sql.includes("status = 'pending'")) {
            const attempt = activeAttempt(params[0]);
            return { rowCount: attempt ? 1 : 0, rows: attempt ? [{ reference: attempt.reference, authorization_url: attempt.url }] : [] };
          }
          if (sql.startsWith("INSERT INTO payments")) {
            state.attempts.push({ id: params[0], invoiceId: params[1], reference: params[2], amountKobo: params[3], status: "pending", url: params[4] });
            return { rowCount: 1, rows: [] };
          }
          if (sql.startsWith("UPDATE payments")) { const attempt = state.attempts.find(item => item.id === params[0]); if (attempt) attempt.status = "success"; return { rowCount: attempt ? 1 : 0, rows: [{ id: params[0] }] }; }
          if (sql.includes("FROM order_items") || (sql.includes("FROM inventory") && sql.includes("FOR UPDATE"))) return { rowCount: 0, rows: [] };
          if (sql.startsWith("UPDATE inventory")) return { rowCount: 1, rows: [] };
          if (sql.startsWith("UPDATE orders SET customer_email")) return { rowCount: 1, rows: [] };
          if (sql.startsWith("UPDATE invoices")) { state.invoiceStatus = "paid"; return { rowCount: 1, rows: [{ id: "invoice-1" }] }; }
          if (sql.startsWith("UPDATE orders")) return { rowCount: 1, rows: [{ id: "order-1" }] };
          if (sql === "COMMIT" || sql === "ROLLBACK") { unlock?.(); unlock = null; return { rowCount: null, rows: [] }; }
          throw new Error(`Unexpected client SQL: ${sql}`);
        },
        release() { unlock?.(); unlock = null; }
      };
    }
  };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  require.cache[orderPath] = { id: orderPath, filename: orderPath, loaded: true, exports: { getOrderWithItems: async () => ({ row: { id: "order-1" }, order: { status: "pending_payment" } }) } };
  require.cache[invoicePath] = { id: invoicePath, filename: invoicePath, loaded: true, exports: { getInvoiceForOrder: async () => ({ id: "invoice-1", invoice_ref: "INV-1", order_ref: "PH-1", order_id: "order-1", amount_ngn: 1250, status: state.invoiceStatus }) } };
  require.cache[chordPath] = { id: chordPath, filename: chordPath, loaded: true, exports: { sendNotification: async () => ({}) } };
  delete require.cache[require.resolve("../src/services/paystack.service")];
  process.env.PAYSTACK_SECRET_KEY = "test-only-placeholder";
  global.fetch = async (url, options = {}) => {
    if (url.endsWith("/transaction/initialize")) {
      const request = JSON.parse(options.body); state.initRequests.push(request);
      return { ok: true, status: 200, json: async () => ({ status: true, data: { reference: request.reference, authorization_url: `https://checkout.example/${request.reference}` } }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: true, data: { reference: decodeURIComponent(url.split("/").pop()), amount: 125000, currency: "NGN", status: state.verificationStatus } }) };
  };
  return { service: require("../src/services/paystack.service"), state };
}

test("checkout initialization sends NGN amount in kobo and stores/returns the exact Paystack reference and URL", async () => {
  const { service, state } = setup();
  const result = await service.initializePayment("PH-1", "buyer@example.com");
  const request = state.initRequests[0];
  const saved = state.attempts[0];
  assert.equal(request.amount, "125000");
  assert.equal(request.currency, "NGN");
  assert.match(request.reference, /^ph-[a-f0-9]{32}$/);
  assert.equal(request.reference, result.body.paymentReference);
  assert.equal(saved.reference, result.body.paymentReference);
  assert.equal(saved.url, result.body.checkoutUrl);
  assert.equal(result.status, 201);
  assert.match(state.statements.find(sql => sql.includes("FROM invoices i JOIN orders o")), /FOR UPDATE OF i/);
});

test("repeated initialization reuses the current still-open checkout instead of creating a conflicting transaction", async () => {
  const { service, state } = setup({ verificationStatus: "ongoing" });
  const first = await service.initializePayment("PH-1", "buyer@example.com");
  const second = await service.initializePayment("PH-1", "buyer@example.com");
  assert.equal(second.body.paymentReference, first.body.paymentReference);
  assert.equal(second.body.checkoutUrl, first.body.checkoutUrl);
  assert.equal(state.initRequests.length, 1);
});

test("two concurrent initialization requests create only one attempt", async () => {
  const { service, state } = setup();
  const results = await Promise.all([
    service.initializePayment("PH-1", "buyer@example.com"),
    service.initializePayment("PH-1", "buyer@example.com")
  ]);
  assert.equal(state.initRequests.length, 1);
  assert.equal(state.attempts.length, 1);
  assert.equal(results[0].body.paymentReference, results[1].body.paymentReference);
  assert.equal(results[0].body.checkoutUrl, results[1].body.checkoutUrl);
});

test("a final failed attempt can be retried with a fresh reference and authorization URL", async () => {
  const { service, state } = setup({ verificationStatus: "failed" });
  const first = await service.initializePayment("PH-1", "buyer@example.com");
  const second = await service.initializePayment("PH-1", "buyer@example.com");
  assert.notEqual(second.body.paymentReference, first.body.paymentReference);
  assert.notEqual(second.body.checkoutUrl, first.body.checkoutUrl);
  assert.equal(state.initRequests.length, 2);
});

test("a reference mismatch in Paystack initialization is rejected and never persisted or returned", async () => {
  const { service, state } = setup();
  global.fetch = async (url, options) => {
    const request = JSON.parse(options.body); state.initRequests.push(request);
    return { ok: true, status: 200, json: async () => ({ status: true, data: { reference: "different-reference", authorization_url: "https://checkout.example/wrong" } }) };
  };
  const result = await service.initializePayment("PH-1", "buyer@example.com");
  assert.equal(result.error.status, 502);
  assert.equal(state.attempts.length, 0);
});

test("paid invoices cannot initialize another checkout", async () => {
  const { service, state } = setup({ invoiceStatus: "paid" });
  const result = await service.initializePayment("PH-1", "buyer@example.com");
  assert.equal(result.error.body.error, "ALREADY_PAID");
  assert.equal(state.initRequests.length, 0);
});

test("an existing checkout that Paystack already completed is verified and cannot be returned for another charge", async () => {
  const { service, state } = setup({ verificationStatus: "success" });
  const first = await service.initializePayment("PH-1", "buyer@example.com");
  const result = await service.initializePayment("PH-1", "buyer@example.com");
  assert.equal(first.status, 201);
  assert.equal(result.error.body.error, "ALREADY_PAID");
  assert.equal(state.initRequests.length, 1);
  assert.equal(state.invoiceStatus, "paid");
});
