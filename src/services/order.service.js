const crypto = require("node:crypto");
const pool = require("../db/pool");
const orderDto = require("../utils/orderDto");

async function getOrderWithItems(db, idOrRef) {
  const result = await db.query(
    `SELECT id, order_ref, status, total_ngn, customer_email, created_at, updated_at
     FROM orders WHERE id::text = $1 OR order_ref = $1`,
    [idOrRef]
  );
  if (!result.rowCount) return null;
  const itemResult = await db.query(
    `SELECT product_id, product_name, unit, quantity, unit_price_ngn, line_total_ngn
     FROM order_items WHERE order_id = $1 ORDER BY id`,
    [result.rows[0].id]
  );
  return { order: orderDto(result.rows[0], itemResult.rows), row: result.rows[0], itemRows: itemResult.rows };
}

async function createOrder({ items, customerEmail, idempotencyKey }) {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    if (idempotencyKey) {
      const reservation = await client.query(
        `INSERT INTO idempotency_keys (key, response_json) VALUES ($1, NULL)
         ON CONFLICT (key) DO NOTHING RETURNING key`, [idempotencyKey]
      );
      if (reservation.rowCount === 0) {
        await client.query("ROLLBACK"); transactionOpen = false;
        const existing = await pool.query("SELECT response_json FROM idempotency_keys WHERE key = $1", [idempotencyKey]);
        if (existing.rowCount && existing.rows[0].response_json) return { duplicate: true, response: { ...existing.rows[0].response_json, duplicate: true } };
        return { conflict: true };
      }
    }

    const quantities = new Map();
    for (const item of items) quantities.set(item.productId.trim(), (quantities.get(item.productId.trim()) || 0) + item.quantity);
    const productIds = [...quantities.keys()].sort();
    const selected = await client.query(
      `SELECT id, name, unit, price_ngn, stock, low_stock_threshold, low_stock_alerted FROM inventory WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [productIds]
    );
    const productMap = new Map(selected.rows.map(row => [row.id, row]));
    for (const productId of productIds) {
      const product = productMap.get(productId);
      if (!product) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return { error: { status: 404, body: { error: "PRODUCT_NOT_FOUND", productId, message: `Product '${productId}' was not found.` } } };
      }
      const requested = quantities.get(productId);
      if (requested > Number(product.stock)) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return { error: { status: 409, body: { error: "INSUFFICIENT_STOCK", product: product.name, requested, available: Number(product.stock), message: "The requested quantity exceeds current available stock." } } };
      }
    }

    const validatedItems = items.map(item => {
      const product = productMap.get(item.productId.trim());
      return { product, quantity: item.quantity, unitPriceNgn: Number(product.price_ngn), lineTotalNgn: Number(product.price_ngn) * item.quantity };
    });
    const totalNgn = validatedItems.reduce((sum, item) => sum + item.lineTotalNgn, 0);
    const orderId = crypto.randomUUID();
    const orderRef = `PH-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const orderResult = await client.query(
      `INSERT INTO orders (id, order_ref, status, total_ngn, customer_email)
       VALUES ($1, $2, 'pending_payment', $3, $4)
       RETURNING id, order_ref, status, total_ngn, customer_email, created_at, updated_at`,
      [orderId, orderRef, totalNgn, customerEmail || null]
    );

    for (const line of validatedItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit, quantity, unit_price_ngn, line_total_ngn)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orderId, line.product.id, line.product.name, line.product.unit, line.quantity, line.unitPriceNgn, line.lineTotalNgn]
      );
    }
    const itemResult = await client.query(
      `SELECT product_id, product_name, unit, quantity, unit_price_ngn, line_total_ngn FROM order_items WHERE order_id = $1 ORDER BY id`,
      [orderId]
    );
    const invoiceRef = `INV-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    const invoiceId = crypto.randomUUID();
    await client.query(
      `INSERT INTO invoices (id, invoice_ref, order_id, amount_ngn, status) VALUES ($1, $2, $3, $4, 'unpaid')`,
      [invoiceId, invoiceRef, orderId, totalNgn]
    );
    const response = { ...orderDto(orderResult.rows[0], itemResult.rows), invoice: { invoiceRef, amountNgn: totalNgn, status: "unpaid" } };
    if (idempotencyKey) {
      const saved = await client.query("UPDATE idempotency_keys SET response_json = $2::jsonb WHERE key = $1 RETURNING key", [idempotencyKey, JSON.stringify(response)]);
      if (saved.rowCount !== 1) throw new Error("Idempotency response could not be saved.");
    }
    await client.query("COMMIT"); transactionOpen = false;
    return { response, status: 201 };
  } catch (error) {
    if (transactionOpen) { try { await client.query("ROLLBACK"); } catch (_) {} }
    throw error;
  } finally { client.release(); }
}

module.exports = { getOrderWithItems, createOrder };
