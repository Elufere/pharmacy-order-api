const test = require("node:test");
const assert = require("node:assert/strict");

function loadOrderService({ reservationExists = false, savedResponse = null, failAt = null } = {}) {
  const poolPath = require.resolve("../src/db/pool");
  const servicePath = require.resolve("../src/services/order.service");
  const state = { stock: 5, stockWrites: 0, orderWrites: 0, itemWrites: 0, invoiceWrites: 0, committed: false, rolledBack: false, savedResponse };
  const client = {
    async query(sql, params = []) {
      const q = sql.trim();
      if (q === "BEGIN") return { rowCount: null, rows: [] };
      if (q === "COMMIT") { state.committed = true; return { rowCount: null, rows: [] }; }
      if (q === "ROLLBACK") { state.rolledBack = true; state.stock = 5; state.stockWrites = 0; state.orderWrites = 0; state.itemWrites = 0; state.invoiceWrites = 0; return { rowCount: null, rows: [] }; }
      if (q.startsWith("INSERT INTO idempotency_keys")) return { rowCount: reservationExists ? 0 : 1, rows: reservationExists ? [] : [{ key: params[0] }] };
      if (q.startsWith("SELECT id, name, unit, price_ngn, stock")) return { rowCount: 1, rows: [{ id: "med-1", name: "Test medicine", unit: "pack", price_ngn: 100, stock: state.stock, low_stock_threshold: 1, low_stock_alerted: false }] };
      if (q.startsWith("INSERT INTO orders")) {
        if (failAt === "order") throw new Error("order insert failed");
        state.orderWrites++;
        return { rowCount: 1, rows: [{ id: params[0], order_ref: params[1], status: "pending_payment", total_ngn: params[2], customer_email: params[3], created_at: new Date(0), updated_at: new Date(0) }] };
      }
      if (q.startsWith("INSERT INTO order_items")) {
        if (failAt === "item") throw new Error("item insert failed");
        state.itemWrites++;
        return { rowCount: 1, rows: [] };
      }
      if (q.startsWith("SELECT product_id, product_name")) return { rowCount: 1, rows: [{ product_id: "med-1", product_name: "Test medicine", unit: "pack", quantity: 2, unit_price_ngn: 100, line_total_ngn: 200 }] };
      if (q.startsWith("INSERT INTO invoices")) {
        if (failAt === "invoice") throw new Error("invoice insert failed");
        state.invoiceWrites++;
        return { rowCount: 1, rows: [] };
      }
      if (q.startsWith("UPDATE idempotency_keys")) {
        if (failAt === "idempotency-save") return { rowCount: 0, rows: [] };
        state.savedResponse = JSON.parse(params[1]);
        return { rowCount: 1, rows: [{ key: params[0] }] };
      }
      throw new Error(`Unexpected SQL: ${q}`);
    },
    release() { state.released = true; }
  };
  const pool = {
    async connect() { return client; },
    async query(sql) {
      assert.match(sql, /SELECT response_json/);
      return state.savedResponse ? { rowCount: 1, rows: [{ response_json: state.savedResponse }] } : { rowCount: 0, rows: [] };
    }
  };
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
  delete require.cache[servicePath];
  return { service: require(servicePath), state };
}

const orderInput = { items: [{ productId: "med-1", quantity: 2 }], customerEmail: "buyer@example.com", idempotencyKey: "request-1" };

test("unpaid order creation writes pending_payment order and invoice without deducting stock", async () => {
  const { service, state } = loadOrderService();
  const result = await service.createOrder(orderInput);
  assert.equal(result.status, 201);
  assert.equal(result.response.status, "pending_payment");
  assert.equal(result.response.invoice.status, "unpaid");
  assert.equal(state.stock, 5);
  assert.equal(state.stockWrites, 0);
  assert.equal(state.orderWrites, 1);
  assert.equal(state.itemWrites, 1);
  assert.equal(state.invoiceWrites, 1);
  assert.equal(state.committed, true);
  assert.equal(state.rolledBack, false);
});

for (const failure of ["order", "item", "invoice", "idempotency-save"]) {
  test(`order creation rolls back when ${failure} write fails`, async () => {
    const { service, state } = loadOrderService({ failAt: failure });
    await assert.rejects(service.createOrder(orderInput));
    assert.equal(state.committed, false);
    assert.equal(state.rolledBack, true);
    assert.equal(state.stock, 5);
    assert.equal(state.orderWrites, 0);
    assert.equal(state.itemWrites, 0);
    assert.equal(state.invoiceWrites, 0);
    assert.equal(state.released, true);
  });
}

test("repeated idempotency key returns stored response without creating another order", async () => {
  const stored = { id: "existing", status: "pending_payment", invoice: { status: "unpaid" } };
  const { service, state } = loadOrderService({ reservationExists: true, savedResponse: stored });
  const result = await service.createOrder(orderInput);
  assert.equal(result.duplicate, true);
  assert.equal(result.response.duplicate, true);
  assert.equal(state.orderWrites, 0);
  assert.equal(state.committed, false);
  assert.equal(state.rolledBack, true);
});

test("unresolved idempotency reservation returns conflict without creating an order", async () => {
  const { service, state } = loadOrderService({ reservationExists: true });
  const result = await service.createOrder(orderInput);
  assert.deepEqual(result, { conflict: true });
  assert.equal(state.orderWrites, 0);
  assert.equal(state.rolledBack, true);
});
