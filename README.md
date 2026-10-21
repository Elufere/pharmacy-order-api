# Pharmacy Order API

Modular Node.js/Express + PostgreSQL API for the Community Pharmacy Demo and Chord assessment. It supports inventory lookup, order intake, invoice records, Paystack test checkout and server-side payment verification, and protected pharmacy fulfilment endpoints.

## Structure

- `src/server.js`: app setup and route mounting
- `src/db/`: PostgreSQL connection pool and startup schema initialization
- `src/routes/`: HTTP routes
- `src/services/`: order, invoice, and Paystack business logic
- `src/middleware/`: pharmacy staff API-key protection
- `src/utils/`: order response DTO mapping

## Environment

- `DATABASE_URL`
- `PAYSTACK_SECRET_KEY`: use a Paystack **test secret key only**
- `PHARMACY_API_KEY`: long, randomly generated secret for staff-only endpoints

Never commit real keys or put the Paystack secret in Chord.

## Run locally

```bash
npm install
DATABASE_URL="postgresql://..." PAYSTACK_SECRET_KEY="sk_test_..." PHARMACY_API_KEY="replace-with-a-long-random-secret" npm start
```

Use your local PostgreSQL connection string and Paystack test credentials.

## Endpoints

- `GET /health`: health check
- `GET /inventory?query=paracetamol`: search inventory
- `POST /orders`: create an order; requires `customerConfirmed: true`. Checks and decrements stock and creates an unpaid invoice within a database transaction.
- `GET /orders/:id-or-orderRef`: retrieve an order
- `GET /orders/:id-or-orderRef/invoice`: retrieve an order's invoice
- `POST /orders/:id-or-orderRef/payment`: initialize Paystack checkout. JSON body: `{"email":"demo@example.com"}`. Only orders with `pending_payment` status can initialize checkout.
- `POST /payments/initialize`: initialize Paystack checkout using JSON body `{"orderRef":"PH-...","email":"demo@example.com"}`. Returns the checkout URL after successful initialization; this does not confirm payment.
- `GET /payments/verify/:reference`: verify a transaction with Paystack server-side. Checks transaction success, reference, amount in kobo, and NGN currency before marking the invoice paid and the order payment-confirmed.
- `GET /pharmacy/orders?status=all`: retrieve orders in the pharmacist workflow. Requires the `x-pharmacy-api-key` header. Supported filters are `all`, `pending_payment`, `payment_confirmed`, and `ready_for_pickup`.
- `PATCH /pharmacy/orders/:id-or-orderRef/status`: update an order's fulfilment status. Requires the `x-pharmacy-api-key` header. The only permitted transition is from `payment_confirmed` to `ready_for_pickup`, using the request body `{"status":"ready_for_pickup"}`. The backend also verifies that the associated invoice is paid.

## Order and payment lifecycle

1. The customer explicitly confirms the itemized order.
2. The API creates the order with status `pending_payment`, creates an invoice with status `unpaid`, and deducts the requested inventory within a database transaction.
3. The customer provides an email address, and the API initializes Paystack checkout using test credentials.
4. The customer completes checkout. Initializing checkout alone does not confirm payment.
5. The API verifies the transaction directly with Paystack. Only a verified successful transaction with the expected reference, amount, and currency can mark the invoice `paid` and move the order to `payment_confirmed`.
6. The pharmacist dashboard can show `pending_payment`, `payment_confirmed`, and `ready_for_pickup` orders.
7. The pharmacist can move an order from `payment_confirmed` to `ready_for_pickup` only when the invoice is paid.

Failed, abandoned, mismatched, or unverifiable payments must not mark the invoice paid. Payment confirmation does not automatically mark an order ready for pickup.

## Render deployment

The Blueprint declares a web service, PostgreSQL database, and secret environment variables. If resources already exist, update the existing service rather than creating duplicates.

Set `DATABASE_URL`, `PAYSTACK_SECRET_KEY`, and `PHARMACY_API_KEY` in the Render service's environment settings as required by the deployment configuration. Use Paystack test credentials and fictional data for the demo.

Generate a staff API key locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Do not commit or share the generated key. The shared-key approach is intended for a controlled demo only.

## Existing data and migration

At startup, schema initialization creates missing tables and columns, updates the order status constraint, migrates legacy order statuses, seeds missing demo inventory without resetting existing stock, and creates missing unpaid invoices for eligible `pending_payment` orders.

Legacy orders with invoices are mapped according to invoice status: paid invoices result in `payment_confirmed`, while unpaid invoices result in `pending_payment`. Legacy orders without invoices are moved to `pending_payment` before missing invoices are created for eligible orders.

Back up important data before deploying schema or migration changes. Review historical records before applying migrations to any production database.

## Limitations

- Invoices are JSON/API records, not downloadable PDF documents.
- Use Paystack test credentials and fictional data only.
- There is no automatic email/SMS receipt or payment webhook; verification is initiated through the API.
- Pharmacist endpoints use a shared API key. Production use requires stronger access controls, audit logs, and key rotation.
- Before real use, add automated tests for concurrency, payment retries and webhooks, timeout recovery, stock reconciliation, backups, monitoring, and cancellation/refund operations.

## AI assistance

AI tools helped draft and refactor the API, documentation, and test plan. The deployed agent runs on Chord and calls this external API.

## Simplified order statuses

- `pending_payment`: the order was created, but payment has not been verified.
- `payment_confirmed`: Paystack verification succeeded and the invoice is paid.
- `ready_for_pickup`: the pharmacist marked the paid order as ready for collection.

The backend restricts pharmacist fulfilment to `payment_confirmed` → `ready_for_pickup` and checks the invoice is paid before allowing that transition.
