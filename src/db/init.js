const pool = require("./pool");

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      unit TEXT NOT NULL,
      price_ngn INTEGER NOT NULL CHECK (price_ngn >= 0),
      stock INTEGER NOT NULL CHECK (stock >= 0),
      low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
      low_stock_alerted BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE inventory ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0);
    ALTER TABLE inventory ADD COLUMN IF NOT EXISTS low_stock_alerted BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      order_ref TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      total_ngn BIGINT NOT NULL CHECK (total_ngn >= 0),
      customer_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

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

    -- Replace only the constraint owned by this initializer before changing
    -- legacy values, so the old allowed-status check does not reject updates.
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

    -- Migrate legacy order statuses into the simplified payment workflow.
    UPDATE orders o
    SET status = CASE
      WHEN i.status = 'paid' THEN 'payment_confirmed'
      ELSE 'pending_payment'
    END,
    updated_at = NOW()
    FROM invoices i
    WHERE i.order_id = o.id
      AND o.status IN ('awaiting_pharmacy_confirmation', 'confirmed');

    -- Legacy orders without invoices must also leave the old workflow.
    UPDATE orders
    SET status = 'pending_payment',
        updated_at = NOW()
    WHERE status IN ('awaiting_pharmacy_confirmation', 'confirmed');

    ALTER TABLE orders ADD CONSTRAINT orders_status_check
      CHECK (status IN (
        'pending_payment',
        'payment_confirmed',
        'ready_for_pickup',
        'awaiting_pharmacy_confirmation',
        'confirmed',
        'rejected'
      ));

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

  await pool.query(`
    INSERT INTO inventory (id, name, unit, price_ngn, stock)
    VALUES
      ('med-001', 'Paracetamol 500 mg', 'pack', 1500, 20),
      ('supp-001', 'Vitamin C', 'bottle', 2000, 12)
    ON CONFLICT (id) DO NOTHING
  `);

  await pool.query(`
    INSERT INTO invoices (id, invoice_ref, order_id, amount_ngn, status)
    SELECT gen_random_uuid(),
          'INV-' || upper(substr(md5(o.order_ref), 1, 10)),
          o.id,
          o.total_ngn,
          'unpaid'
    FROM orders o
    LEFT JOIN invoices i ON i.order_id = o.id
    WHERE i.id IS NULL
      AND o.status = 'pending_payment'
    ON CONFLICT DO NOTHING
  `);
}

module.exports = initializeDatabase;
