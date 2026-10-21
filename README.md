# Pharmacy Order API

Node.js/Express and PostgreSQL API for the Community Pharmacy Demo / Chord assessment. Includes inventory lookup, order intake, invoices, Paystack test checkout and verification, and protected pharmacy fulfilment endpoints.

## Requirements
- Node.js 20+
- PostgreSQL
- `DATABASE_URL`
- `PAYSTACK_SECRET_KEY` (Paystack test secret key for payment testing)
- `PHARMACY_API_KEY` (long random secret used only by pharmacy staff endpoints)

## Run locally
```bash
npm install
DATABASE_URL="postgresql://..." PAYSTACK_SECRET_KEY="sk_test_..." PHARMACY_API_KEY="replace-with-a-long-random-secret" npm start
```

Do not commit secrets or use live payment keys for this demo.

## Endpoints
- `GET /health`
- `GET /inventory?query=paracetamol`
- `POST /orders` — requires `customerConfirmed: true`; creates order, decrements stock transactionally, and creates an unpaid invoice.
- `GET /orders/:id-or-orderRef`
- `GET /orders/:id-or-orderRef/invoice`
- `POST /orders/:id-or-orderRef/payment` — body: `{"email":"demo@example.com"}`; returns a Paystack hosted checkout URL.
- `GET /payments/verify/:reference` — verifies status, reference, amount and NGN currency with Paystack before marking invoice paid.
- `GET /pharmacy/orders?status=awaiting_pharmacy_confirmation` — requires `x-pharmacy-api-key`.
- `PATCH /pharmacy/orders/:id-or-orderRef/status` — requires `x-pharmacy-api-key`; JSON body e.g. `{"status":"confirmed"}`, then `{"status":"ready_for_pickup"}` or `{"status":"rejected"}`.

## Order and payment lifecycle
1. Customer explicitly confirms an itemized order.
2. API creates the order and invoice (`unpaid`).
3. Customer provides an email; API initializes Paystack test checkout using the server-side secret key.
4. After checkout, call the verify endpoint using the returned payment reference.
5. Invoice is marked paid only when Paystack's server response reports a successful transaction with the expected reference, amount in kobo, and `NGN` currency.
6. Pharmacy staff use protected endpoints to confirm/reject orders and mark confirmed orders ready for pickup.

Payment state and pharmacy fulfilment state are separate. Payment does not automatically mark an order ready. A failed, abandoned, mismatched or unverifiable payment leaves the invoice unpaid.

## Render deployment
The `render.yaml` blueprint declares the web service, PostgreSQL database, and two secret environment variables. Existing Render services may already exist; avoid creating duplicate services/databases. Set `PAYSTACK_SECRET_KEY` and `PHARMACY_API_KEY` under the existing service's Environment settings. Render can redeploy after saving.

Generate a staff key locally, for example:
```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```
Set the generated value in Render as `PHARMACY_API_KEY`. Never put it in a public Chord tool or source control. For this exercise, call the staff endpoints only from a controlled test client; do not expose staff credentials to customers.

## Database migration and existing data
On startup, the service adds the invoice/payment tables, adds `customer_email` and `updated_at` columns if missing, updates the allowed order statuses, and creates unpaid invoice records for existing orders. It seeds demo inventory only when product IDs are missing and does not reset stock.

## Important demo limitations
- The invoice is a structured JSON record, not a downloadable PDF.
- Paystack is configured for test mode only; use only fictional data.
- This demo does not send email/SMS receipts or customer notifications.
- Pharmacy staff endpoints use a shared API key, suitable only for a controlled demo; production needs stronger identity/access management, audit logs, and secret rotation.
- Before real use, add automated tests for concurrent orders, duplicate payments/webhooks, payment timeouts, stock reconciliation, backups, monitoring, and pharmacy operational processes.

## AI assistance
AI tools were used to help draft and review the API implementation, documentation, and test plan. The deployed agent itself runs on Chord and calls this external API.
