const express = require("express");
const crypto = require("node:crypto");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Configure PostgreSQL before starting.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "32kb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const paystackSecret = process.env.PAYSTACK_SECRET_KEY || "";
const pharmacyApiKey = process.env.PHARMACY_API_KEY || "";

function requirePharmacyKey(req, res, next) {
  if (!pharmacyApiKey) {
    return res.status(503).json({
      error: "PHARMACY_ACCESS_NOT_CONFIGURED",
      message: "Set PHARMACY_API_KEY in the service environment before using pharmacy staff endpoints."
    });
  }
  const supplied = req.header("x-pharmacy-api-key");
  if (!supplied || supplied !== pharmacyApiKey) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "Valid pharmacy staff credentials are required." });
  }
  next();
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      price_ngn INTEGER NOT NULL CHECK (price_ngn >= 0),
      stock INTEGER NOT NULL CHECK (stock >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      order_ref TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'awaiting_pharmacy_confirmation',
      total_ngn BIGINT NOT NULL CHECK (total_ngn >= 0),
      customer_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    DO $$
    DECLARE c RECORD;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'orders'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
      LOOP
        EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', c.conname);
      END LOOP;
    END $$;

    ALTER TABLE orders ADD CONSTRAINT orders_status_check
      CHECK (status IN ('awaiting_pharmacy_confirmation', 'confirmed', 'rejected', 'ready_for_pickup'));

    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES inventory(id),
      product_name TEXT NOT NULL,
      unit TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_ngn INTEGER NOT NULL CHECK (unit_price_ngn >= 0),
      line_total_ngn BIGINT NOT NULL CHECK (line_total_ngn >= 0)
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      response_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id UUID PRIMARY KEY,
      invoice_ref TEXT NOT NULL UNIQUE,
      order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
      amount_ngn BIGINT NOT NULL CHECK (amount_ngn >= 0),
      status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid', 'void')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY,
      invoice_id UUID NOT NULL REFERENCES invoices(id),
      provider TEXT NOT NULL DEFAULT 'paystack',
      reference TEXT NOT NULL UNIQUE,
      amount_kobo BIGINT NOT NULL CHECK (amount_kobo >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
      authorization_url TEXT,
      provider_transaction_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders(status, created_at);
    CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments(invoice_id);
  `);

  // Seed only missing demo products. Never reset stock during restart.
  await pool.query(`
    INSERT INTO inventory (id, name, unit, price_ngn, stock)
    VALUES
      ('med-001', 'Paracetamol 500 mg', 'pack', 1500, 20),
      ('supp-001', 'Vitamin C', 'bottle', 2000, 12)
    ON CONFLICT (id) DO NOTHING
  `);

  // Create invoices for orders made by the earlier API version.
  await pool.query(`
    INSERT INTO invoices (id, invoice_ref, order_id, amount_ngn, status)
    SELECT gen_random_uuid(), 'INV-' || upper(substr(md5(o.order_ref), 1, 10)),
           o.id, o.total_ngn, 'unpaid'
    FROM orders o
    LEFT JOIN invoices i ON i.order_id = o.id
    WHERE i.id IS NULL
    ON CONFLICT DO NOTHING
  `);
}

function productDto(row) {
  return { id: row.id, name: row.name, unit: row.unit, priceNgn: Number(row.price_ngn), stock: Number(row.stock) };
}

function orderDto(orderRow, itemRows) {
  return {
    id: orderRow.id,
    orderRef: orderRow.order_ref,
    status: orderRow.status,
    customerEmail: orderRow.customer_email || undefined,
    createdAt: orderRow.created_at,
    updatedAt: orderRow.updated_at || orderRow.created_at,
    items: itemRows.map(row => ({
      productId: row.product_id,
      productName: row.product_name,
      unit: row.unit,
      quantity: Number(row.quantity),
      unitPriceNgn: Number(row.unit_price_ngn),
      lineTotalNgn: Number(row.line_total_ngn)
    })),
    totalNgn: Number(orderRow.total_ngn)
  };
}

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

async function getInvoiceForOrder(orderId) {
  const result = await pool.query(
    `SELECT i.id, i.invoice_ref, i.order_id, i.amount_ngn, i.status, i.created_at, i.paid_at,
            o.order_ref, o.status AS order_status
     FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.order_id = $1`,
    [orderId]
  );
  return result.rows[0] || null;
}

app.get("/", (_req, res) => res.json({
  service: "Community Pharmacy Demo API",
  status: "ok",
  endpoints: [
    "GET /health",
    "GET /inventory?query=paracetamol",
    "POST /orders",
    "GET /orders/:id",
    "GET /orders/:id/invoice",
    "POST /orders/:id/payment",
    "GET /payments/verify/:reference",
    "GET /pharmacy/orders?status=awaiting_pharmacy_confirmation",
    "PATCH /pharmacy/orders/:id/status"
  ]
}));

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected", service: "pharmacy-order-api", paystackConfigured: Boolean(paystackSecret) });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.get("/inventory", async (req, res, next) => {
  try {
    const query = String(req.query.query || "").trim().toLowerCase();
    const result = query
      ? await pool.query(
          `SELECT id, name, unit, price_ngn, stock FROM inventory
           WHERE LOWER(name) LIKE $1 OR LOWER(id) = $2 ORDER BY name`,
          [`%${query}%`, query]
        )
      : await pool.query("SELECT id, name, unit, price_ngn, stock FROM inventory ORDER BY name");
    res.json({ items: result.rows.map(productDto), count: result.rowCount });
  } catch (error) { next(error); }
});

app.post("/orders", async (req, res, next) => {
  const { customerConfirmed, items } = req.body || {};
  const customerEmail = typeof req.body?.customerEmail === "string" ? req.body.customerEmail.trim().toLowerCase() : null;
  const idempotencyKey = String(req.header("Idempotency-Key") || "").trim();

  if (customerConfirmed !== true) {
    return res.status(400).json({ error: "CUSTOMER_CONFIRMATION_REQUIRED", message: "The customer must explicitly confirm the final order before it can be created." });
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) {
    return res.status(400).json({ error: "INVALID_ITEMS", message: "Provide between 1 and 10 order items." });
  }
  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return res.status(400).json({ error: "INVALID_EMAIL", message: "Provide a valid customer email address." });
  }
  for (const item of items) {
    if (!item || typeof item.productId !== "string" || !item.productId.trim() || !Number.isInteger(item.quantity) || item.quantity <= 0) {
      return res.status(400).json({ error: "INVALID_ITEM", message: "Each item requires a productId and a positive whole-number quantity." });
    }
  }

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
        if (existing.rowCount && existing.rows[0].response_json) return res.status(200).json({ ...existing.rows[0].response_json, duplicate: true });
        return res.status(409).json({ error: "IDEMPOTENCY_CONFLICT", message: "This idempotency key is already being processed. Retry shortly with the same key." });
      }
    }

    const quantities = new Map();
    for (const item of items) quantities.set(item.productId.trim(), (quantities.get(item.productId.trim()) || 0) + item.quantity);
    const productIds = [...quantities.keys()].sort();
    const selected = await client.query(
      `SELECT id, name, unit, price_ngn, stock FROM inventory WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [productIds]
    );
    const productMap = new Map(selected.rows.map(row => [row.id, row]));
    for (const productId of productIds) {
      const product = productMap.get(productId);
      if (!product) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(404).json({ error: "PRODUCT_NOT_FOUND", productId, message: `Product '${productId}' was not found.` });
      }
      const requested = quantities.get(productId);
      if (requested > Number(product.stock)) {
        await client.query("ROLLBACK"); transactionOpen = false;
        return res.status(409).json({ error: "INSUFFICIENT_STOCK", product: product.name, requested, available: Number(product.stock), message: "The requested quantity exceeds current available stock." });
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
       VALUES ($1, $2, 'awaiting_pharmacy_confirmation', $3, $4)
       RETURNING id, order_ref, status, total_ngn, customer_email, created_at, updated_at`,
      [orderId, orderRef, totalNgn, customerEmail]
    );
    for (const line of validatedItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit, quantity, unit_price_ngn, line_total_ngn)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orderId, line.product.id, line.product.name, line.product.unit, line.quantity, line.unitPriceNgn, line.lineTotalNgn]
      );
    }
    for (const [productId, quantity] of quantities) {
      await client.query("UPDATE inventory SET stock = stock - $1, updated_at = NOW() WHERE id = $2", [quantity, productId]);
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
    if (idempotencyKey) await client.query("UPDATE idempotency_keys SET response_json = $2::jsonb WHERE key = $1", [idempotencyKey, JSON.stringify(response)]);
    await client.query("COMMIT"); transactionOpen = false;
    return res.status(201).json(response);
  } catch (error) {
    if (transactionOpen) { try { await client.query("ROLLBACK"); } catch (_) {} }
    return next(error);
  } finally { client.release(); }
});

app.get("/orders/:id", async (req, res, next) => {
  try {
    const result = await getOrderWithItems(pool, req.params.id);
    if (!result) return res.status(404).json({ error: "ORDER_NOT_FOUND", message: "No order was found for that reference." });
    const invoice = await getInvoiceForOrder(result.row.id);
    res.json({ ...result.order, invoice: invoice ? { invoiceRef: invoice.invoice_ref, amountNgn: Number(invoice.amount_ngn), status: invoice.status, paidAt: invoice.paid_at } : null });
  } catch (error) { next(error); }
});

app.get("/orders/:id/invoice", async (req, res, next) => {
  try {
    const orderResult = await getOrderWithItems(pool, req.params.id);
    if (!orderResult) return res.status(404).json({ error: "ORDER_NOT_FOUND", message: "No order was found for that reference." });
    const invoice = await getInvoiceForOrder(orderResult.row.id);
    if (!invoice) return res.status(404).json({ error: "INVOICE_NOT_FOUND", message: "No invoice exists for this order." });
    res.json({
      invoiceRef: invoice.invoice_ref,
      orderRef: invoice.order_ref,
      issuedAt: invoice.created_at,
      amountNgn: Number(invoice.amount_ngn),
      status: invoice.status,
      paidAt: invoice.paid_at,
      currency: "NGN",
      items: orderResult.order.items,
      note: "Demo invoice. Payment is not confirmed until the server verifies a successful Paystack transaction."
    });
  } catch (error) { next(error); }
});

app.post("/orders/:id/payment", async (req, res, next) => {
  if (!paystackSecret) return res.status(503).json({ error: "PAYMENTS_NOT_CONFIGURED", message: "Paystack test payments are not configured on this service." });
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "VALID_EMAIL_REQUIRED", message: "A valid email address is required to initialize Paystack checkout." });

  try {
    const orderResult = await getOrderWithItems(pool, req.params.id);
    if (!orderResult) return res.status(404).json({ error: "ORDER_NOT_FOUND", message: "No order was found for that reference." });
    if (["rejected"].includes(orderResult.order.status)) return res.status(409).json({ error: "ORDER_NOT_PAYABLE", message: "Rejected orders cannot be paid." });
    const invoice = await getInvoiceForOrder(orderResult.row.id);
    if (!invoice) return res.status(404).json({ error: "INVOICE_NOT_FOUND", message: "No invoice exists for this order." });
    if (invoice.status === "paid") return res.status(409).json({ error: "ALREADY_PAID", message: "This invoice has already been paid." });

    const reference = `ph_${crypto.randomUUID().replace(/-/g, "")}`;
    const amountKobo = Number(invoice.amount_ngn) * 100;
    const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${paystackSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        amount: String(amountKobo),
        currency: "NGN",
        reference,
        metadata: { orderRef: invoice.order_ref, invoiceRef: invoice.invoice_ref }
      }),
      signal: AbortSignal.timeout(15000)
    });
    const payload = await paystackResponse.json().catch(() => null);
    if (!paystackResponse.ok || !payload?.status || !payload?.data?.authorization_url || !payload?.data?.reference) {
      console.error("Paystack initialization failed:", payload?.message || paystackResponse.status);
      return res.status(502).json({ error: "PAYMENT_INITIALIZATION_FAILED", message: "Paystack could not initialize checkout. No payment has been confirmed; retry or contact the pharmacy." });
    }

    await pool.query(
      `INSERT INTO payments (id, invoice_id, reference, amount_kobo, status, authorization_url)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [crypto.randomUUID(), invoice.id, payload.data.reference, amountKobo, payload.data.authorization_url]
    );
    await pool.query("UPDATE orders SET customer_email = COALESCE(customer_email, $2), updated_at = NOW() WHERE id = $1", [orderResult.row.id, email]);
    res.status(201).json({
      orderRef: invoice.order_ref,
      invoiceRef: invoice.invoice_ref,
      paymentReference: payload.data.reference,
      amountNgn: Number(invoice.amount_ngn),
      currency: "NGN",
      paymentStatus: "pending",
      checkoutUrl: payload.data.authorization_url,
      message: "Open the checkout URL to complete the test payment. The order is not marked paid until verification succeeds."
    });
  } catch (error) { next(error); }
});

app.get("/payments/verify/:reference", async (req, res, next) => {
  if (!paystackSecret) return res.status(503).json({ error: "PAYMENTS_NOT_CONFIGURED", message: "Paystack test payments are not configured on this service." });
  const reference = String(req.params.reference || "");
  try {
    const paymentResult = await pool.query(
      `SELECT p.id, p.invoice_id, p.reference, p.amount_kobo, p.status, i.order_id, i.amount_ngn, i.status AS invoice_status
       FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.reference = $1`,
      [reference]
    );
    if (!paymentResult.rowCount) return res.status(404).json({ error: "PAYMENT_NOT_FOUND", message: "No payment attempt was found for that reference." });
    const payment = paymentResult.rows[0];
    if (payment.status === "success" && payment.invoice_status === "paid") {
      return res.json({ paymentStatus: "success", invoiceStatus: "paid", reference, message: "Payment was already verified." });
    }

    const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${paystackSecret}` },
      signal: AbortSignal.timeout(15000)
    });
    const payload = await verifyResponse.json().catch(() => null);
    if (!verifyResponse.ok || !payload?.status || !payload?.data) {
      console.error("Paystack verification failed:", payload?.message || verifyResponse.status);
      return res.status(502).json({ error: "PAYMENT_VERIFICATION_FAILED", message: "Could not verify payment with Paystack. The invoice remains unpaid until verification succeeds." });
    }

    const transaction = payload.data;
    const amountMatches = Number(transaction.amount) === Number(payment.amount_kobo);
    const currencyMatches = transaction.currency === "NGN";
    const referenceMatches = transaction.reference === reference;
    const success = transaction.status === "success" && amountMatches && currencyMatches && referenceMatches;

    if (success) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE payments SET status = 'success', provider_transaction_id = $2, verified_at = NOW() WHERE id = $1`,
          [payment.id, String(transaction.id)]
        );
        await client.query("UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = $1", [payment.invoice_id]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      return res.json({ paymentStatus: "success", invoiceStatus: "paid", reference, amountNgn: Number(payment.amount_ngn), currency: "NGN", message: "Paystack payment verified successfully." });
    }

    const status = transaction.status === "abandoned" ? "abandoned" : "failed";
    await pool.query("UPDATE payments SET status = $2, verified_at = NOW() WHERE id = $1 AND status <> 'success'", [payment.id, status]);
    return res.status(409).json({
      paymentStatus: status,
      invoiceStatus: "unpaid",
      reference,
      checks: { transactionStatus: transaction.status, amountMatches, currencyMatches, referenceMatches },
      message: "Payment was not verified as a successful transaction for the expected amount and currency. The invoice remains unpaid."
    });
  } catch (error) { next(error); }
});

app.get("/pharmacy/orders", requirePharmacyKey, async (req, res, next) => {
  try {
    const status = String(req.query.status || "awaiting_pharmacy_confirmation");
    const allowed = ["awaiting_pharmacy_confirmation", "confirmed", "rejected", "ready_for_pickup"];
    if (!allowed.includes(status)) return res.status(400).json({ error: "INVALID_STATUS_FILTER", allowed });
    const result = await pool.query(
      `SELECT id, order_ref, status, total_ngn, customer_email, created_at, updated_at
       FROM orders WHERE status = $1 ORDER BY created_at ASC LIMIT 100`, [status]
    );
    const orders = [];
    for (const row of result.rows) {
      const details = await getOrderWithItems(pool, row.order_ref);
      const invoice = await getInvoiceForOrder(row.id);
      orders.push({ ...details.order, invoice: invoice ? { invoiceRef: invoice.invoice_ref, status: invoice.status } : null });
    }
    res.json({ count: orders.length, orders });
  } catch (error) { next(error); }
});

app.patch("/pharmacy/orders/:id/status", requirePharmacyKey, async (req, res, next) => {
  const targetStatus = req.body?.status;
  const transitions = {
    awaiting_pharmacy_confirmation: ["confirmed", "rejected"],
    confirmed: ["ready_for_pickup"],
    ready_for_pickup: [],
    rejected: []
  };
  if (!Object.hasOwn(transitions, targetStatus) || !["confirmed", "rejected", "ready_for_pickup"].includes(targetStatus)) {
    return res.status(400).json({ error: "INVALID_TARGET_STATUS", allowed: ["confirmed", "rejected", "ready_for_pickup"] });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT id, order_ref, status FROM orders WHERE id::text = $1 OR order_ref = $1 FOR UPDATE",
      [req.params.id]
    );
    if (!current.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "ORDER_NOT_FOUND" }); }
    const order = current.rows[0];
    if (!transitions[order.status]?.includes(targetStatus)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "INVALID_STATUS_TRANSITION", currentStatus: order.status, requestedStatus: targetStatus, allowedNextStatuses: transitions[order.status] || [] });
    }
    const updated = await client.query(
      "UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING order_ref, status, updated_at",
      [order.id, targetStatus]
    );
    await client.query("COMMIT");
    res.json({ orderRef: updated.rows[0].order_ref, status: updated.rows[0].status, updatedAt: updated.rows[0].updated_at });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    next(error);
  } finally { client.release(); }
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "INVALID_JSON", message: "Request body must be valid JSON." });
  console.error(err);
  res.status(500).json({ error: "INTERNAL_ERROR", message: "Unexpected server error." });
});

const port = Number(process.env.PORT || 3000);
initializeDatabase()
  .then(() => app.listen(port, "0.0.0.0", () => console.log(`Pharmacy demo API listening on port ${port}`)))
  .catch(error => { console.error("Database initialization failed:", error); process.exit(1); });

async function shutdown() { await pool.end(); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
