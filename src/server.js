const express = require("express");
const crypto = require("node:crypto");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Configure a PostgreSQL database before starting.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "32kb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's internal URL is preferred for a service in the same region.
  // External database URLs require TLS; Render's managed URLs support sslmode=require.
  ssl: process.env.DATABASE_URL.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

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
      status TEXT NOT NULL CHECK (status = 'awaiting_pharmacy_confirmation'),
      total_ngn BIGINT NOT NULL CHECK (total_ngn >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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
  `);

  // Seed only missing products. Existing stock/price edits are preserved across restarts.
  await pool.query(`
    INSERT INTO inventory (id, name, unit, price_ngn, stock)
    VALUES
      ('med-001', 'Paracetamol 500 mg', 'pack', 1500, 20),
      ('supp-001', 'Vitamin C', 'bottle', 2000, 12)
    ON CONFLICT (id) DO NOTHING
  `);
}

function productDto(row) {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    priceNgn: Number(row.price_ngn),
    stock: Number(row.stock)
  };
}

function orderDto(orderRow, itemRows) {
  return {
    id: orderRow.id,
    orderRef: orderRow.order_ref,
    status: orderRow.status,
    createdAt: orderRow.created_at,
    items: itemRows.map((row) => ({
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

app.get("/", (_req, res) => res.json({
  service: "Community Pharmacy Demo API",
  status: "ok",
  endpoints: [
    "GET /health",
    "GET /inventory?query=paracetamol",
    "POST /orders",
    "GET /orders/:id"
  ]
}));

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected", service: "pharmacy-order-api" });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.get("/inventory", async (req, res, next) => {
  try {
    const query = String(req.query.query || "").trim().toLowerCase();
    let result;
    if (!query) {
      result = await pool.query("SELECT id, name, unit, price_ngn, stock FROM inventory ORDER BY name");
    } else {
      result = await pool.query(
        `SELECT id, name, unit, price_ngn, stock
         FROM inventory
         WHERE LOWER(name) LIKE $1 OR LOWER(id) = $2
         ORDER BY name`,
        [`%${query}%`, query]
      );
    }
    res.json({ items: result.rows.map(productDto), count: result.rowCount });
  } catch (error) {
    next(error);
  }
});

app.post("/orders", async (req, res, next) => {
  const { customerConfirmed, items } = req.body || {};
  const idempotencyKey = String(req.header("Idempotency-Key") || "").trim();

  if (customerConfirmed !== true) {
    return res.status(400).json({
      error: "CUSTOMER_CONFIRMATION_REQUIRED",
      message: "The customer must explicitly confirm the final order before it can be created."
    });
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) {
    return res.status(400).json({
      error: "INVALID_ITEMS",
      message: "Provide between 1 and 10 order items."
    });
  }
  for (const item of items) {
    if (!item || typeof item.productId !== "string" || !item.productId.trim() ||
        !Number.isInteger(item.quantity) || item.quantity <= 0) {
      return res.status(400).json({
        error: "INVALID_ITEM",
        message: "Each item requires a productId and a positive whole-number quantity."
      });
    }
  }

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;

    if (idempotencyKey) {
      const reservation = await client.query(
        `INSERT INTO idempotency_keys (key, response_json)
         VALUES ($1, NULL)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [idempotencyKey]
      );

      if (reservation.rowCount === 0) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        // The conflicting insert waits for an in-flight transaction to commit/rollback.
        const existing = await pool.query(
          "SELECT response_json FROM idempotency_keys WHERE key = $1",
          [idempotencyKey]
        );
        if (existing.rowCount && existing.rows[0].response_json) {
          return res.status(200).json({ ...existing.rows[0].response_json, duplicate: true });
        }
        return res.status(409).json({
          error: "IDEMPOTENCY_CONFLICT",
          message: "This idempotency key is already being processed. Retry shortly with the same key."
        });
      }
    }

    const quantities = new Map();
    for (const item of items) {
      const productId = item.productId.trim();
      quantities.set(productId, (quantities.get(productId) || 0) + item.quantity);
    }
    const productIds = [...quantities.keys()].sort();

    // Lock product rows in a stable order so simultaneous orders cannot oversell stock.
    const selected = await client.query(
      `SELECT id, name, unit, price_ngn, stock
       FROM inventory
       WHERE id = ANY($1::text[])
       ORDER BY id
       FOR UPDATE`,
      [productIds]
    );
    const productMap = new Map(selected.rows.map((row) => [row.id, row]));

    for (const productId of productIds) {
      const product = productMap.get(productId);
      if (!product) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return res.status(404).json({
          error: "PRODUCT_NOT_FOUND",
          productId,
          message: `Product '${productId}' was not found.`
        });
      }
      const requested = quantities.get(productId);
      if (requested > Number(product.stock)) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        return res.status(409).json({
          error: "INSUFFICIENT_STOCK",
          product: product.name,
          requested,
          available: Number(product.stock),
          message: "The requested quantity exceeds current available stock."
        });
      }
    }

    const validatedItems = items.map((item) => {
      const product = productMap.get(item.productId.trim());
      return {
        product,
        quantity: item.quantity,
        unitPriceNgn: Number(product.price_ngn),
        lineTotalNgn: Number(product.price_ngn) * item.quantity
      };
    });

    const totalNgn = validatedItems.reduce((sum, item) => sum + item.lineTotalNgn, 0);
    const orderId = crypto.randomUUID();
    const orderRef = `PH-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

    const orderResult = await client.query(
      `INSERT INTO orders (id, order_ref, status, total_ngn)
       VALUES ($1, $2, 'awaiting_pharmacy_confirmation', $3)
       RETURNING id, order_ref, status, total_ngn, created_at`,
      [orderId, orderRef, totalNgn]
    );

    for (const line of validatedItems) {
      await client.query(
        `INSERT INTO order_items
          (order_id, product_id, product_name, unit, quantity, unit_price_ngn, line_total_ngn)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          orderId,
          line.product.id,
          line.product.name,
          line.product.unit,
          line.quantity,
          line.unitPriceNgn,
          line.lineTotalNgn
        ]
      );
    }

    for (const [productId, quantity] of quantities) {
      await client.query(
        `UPDATE inventory SET stock = stock - $1, updated_at = NOW()
         WHERE id = $2`,
        [quantity, productId]
      );
    }

    const itemResult = await client.query(
      `SELECT product_id, product_name, unit, quantity, unit_price_ngn, line_total_ngn
       FROM order_items WHERE order_id = $1 ORDER BY id`,
      [orderId]
    );
    const response = orderDto(orderResult.rows[0], itemResult.rows);

    if (idempotencyKey) {
      await client.query(
        "UPDATE idempotency_keys SET response_json = $2::jsonb WHERE key = $1",
        [idempotencyKey, JSON.stringify(response)]
      );
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return res.status(201).json(response);
  } catch (error) {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    return next(error);
  } finally {
    client.release();
  }
});

app.get("/orders/:id", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, order_ref, status, total_ngn, created_at
       FROM orders
       WHERE id::text = $1 OR order_ref = $1`,
      [req.params.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "ORDER_NOT_FOUND", message: "No order was found for that reference." });
    }
    const itemResult = await pool.query(
      `SELECT product_id, product_name, unit, quantity, unit_price_ngn, line_total_ngn
       FROM order_items WHERE order_id = $1 ORDER BY id`,
      [result.rows[0].id]
    );
    res.json(orderDto(result.rows[0], itemResult.rows));
  } catch (error) {
    next(error);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "INVALID_JSON", message: "Request body must be valid JSON." });
  }
  console.error(err);
  res.status(500).json({ error: "INTERNAL_ERROR", message: "Unexpected server error." });
});

const port = Number(process.env.PORT || 3000);
initializeDatabase()
  .then(() => app.listen(port, "0.0.0.0", () => {
    console.log(`Pharmacy demo API listening on port ${port}`);
  }))
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });

async function shutdown() {
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
