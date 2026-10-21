# Database migrations

For this demo, schema initialization is idempotently performed by `src/db/init.js` at startup.
It adds invoice/payment tables and missing columns, updates the order status constraint, seeds only missing demo products, and creates unpaid invoices for existing orders.

For a production service, replace startup DDL with versioned migrations and a reviewed rollback strategy.
