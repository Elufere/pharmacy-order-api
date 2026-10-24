# Pharmacy Assistant — Chord assessment

**Preferred role: Forward-Deployed Engineering**

The business is a community pharmacy that needs to answer stock and price questions and capture customer orders consistently. The assistant uses live inventory and order tools so staff spend less time checking stock manually and customers receive a clear order reference and payment state. A pharmacy could pay for this workflow because missed enquiries, incorrect stock promises, and untracked orders cost staff time and sales. This demo deliberately excludes diagnosis and prescribing, delivery, cancellation/refund handling, production customer messaging, and production payment credentials.

## Project and architecture

This repository contains the Node.js/Express backend, PostgreSQL schema initialization, tests, deployment configuration, and submission notes. It does **not** contain the Chord teammate's prompt, tool definitions, skills, or an export of its configuration. The known project setup has a Chord teammate calling this API, but reviewers need an invitation or other authorized access to the Chord workspace and the Pharmacy Assistant teammate to inspect or interact with that agent. No reviewer access or live account was verifiable during this repository audit.

- `src/server.js`: Express application, JSON parsing, routes, and database startup.
- `src/routes/`: inventory, order, payment, and staff fulfilment endpoints.
- `src/services/`: order/invoice logic, Paystack checkout and verification, and Chord scheduled-task requests.
- `src/db/init.js`: idempotent schema initialization, legacy status migration, and demo inventory seed.
- `test/`: Node's built-in test suite. External services and database behavior are mocked; these tests are not live integration proof.
- `render.yaml`: Render Blueprint for the web service and PostgreSQL database.

## Local setup

Requirements: Node.js 20 or newer and a PostgreSQL database. Copy `.env.example` to `.env`, replace placeholders locally, and do not commit `.env` or share its secrets.

```sh
npm install
npm start
```

For development, use `npm run dev`. The service listens on port 3000 by default, or `PORT` when provided. It initializes the schema before listening. Use a disposable database: order creation changes stock and the startup initializer seeds only missing inventory; it does not reset existing values.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string. |
| `PAYSTACK_SECRET_KEY` | For payments | Paystack secret. Use a test key for this demo; never put it in Chord. |
| `PHARMACY_API_KEY` | For staff routes | Shared key sent as `x-pharmacy-api-key`. |
| `CHORD_API_KEY` | For notifications | Chord API bearer key. |
| `CHORD_WORKSPACE_ID` | For notifications | Chord workspace used to create scheduled tasks. |
| `CHORD_TEAMMATE_ID` | For notifications | Chord teammate used to create scheduled tasks. |
| `CHORD_CONVERSATION_ID` | For notifications | Explicitly configured Direct Line conversation destination. The code does not look up a customer conversation. |
| `CHORD_BASE_URL` | No | Chord API base URL; defaults to `https://api.chordhq.xyz`. Set only for an authorized environment. |
| `PORT` | No | HTTP port; defaults to `3000`. |

## Run and test

```sh
npm test
git diff --check
```

Tests use stubs/mocks for PostgreSQL, Paystack, and Chord. A passing suite verifies local behavior under those test doubles, not the live provider, Chord dashboard, or customer-facing simulator.

## API and workflow

- `GET /health` reports service and database status.
- `GET /inventory?query=paracetamol` searches stock.
- `POST /inventory` registers a medicine and requires `x-pharmacy-api-key`. Send `id` (unique SKU/identifier), `name`, `unit`, non-negative integer `priceNgn`, non-negative integer `stock`, and non-negative integer `lowStockThreshold`. Example: `curl -X POST http://localhost:3000/inventory -H 'Content-Type: application/json' -H 'x-pharmacy-api-key: YOUR_KEY' -d '{"id":"med-003","name":"Ibuprofen 200 mg","unit":"pack","priceNgn":1800,"stock":12,"lowStockThreshold":4}'`.
- `POST /inventory/:id/top-up` requires `x-pharmacy-api-key` and a positive integer `quantity`; it adds that amount atomically. Example: `curl -X POST http://localhost:3000/inventory/med-003/top-up -H 'Content-Type: application/json' -H 'x-pharmacy-api-key: YOUR_KEY' -d '{"quantity":10}'`.
- `POST /orders` creates an order only when `customerConfirmed: true`; it validates current availability and writes the order, items, invoice, and optional idempotency response together. It does not deduct stock while the order is unpaid.
- `POST /payments/initialize` or `POST /orders/:id/payment` creates a Paystack checkout and records a pending attempt. Checkout initialization is not payment confirmation.
- `GET /payments/verify/:reference` verifies with Paystack from the server. `POST /payments/webhook` checks Paystack's HMAC signature and independently verifies successful charge references.
- Payment confirmation requires provider status `success`, the expected reference, exact amount in kobo, and `NGN`. The verified payment, invoice, order, and stock deduction are committed in one database transaction. Inventory rows are locked and rechecked during verification to prevent concurrent successful orders from overselling stock. If stock has changed since order creation, verification returns `INSUFFICIENT_STOCK_AFTER_PAYMENT` for staff resolution; Paystack has already reported success, and this API does not automatically refund that charge.
- `GET /pharmacy/orders` and `PATCH /pharmacy/orders/:id/status` require the staff key. The only fulfilment transition is a paid `payment_confirmed` order to `ready_for_pickup`.

After a successful commit, the backend asks Chord to create a scheduled `MESSAGE` task using `/v1/scheduled-tasks`. The request uses a one-minute scheduled time, `DIRECT_LINE`, and the configured conversation ID. The project history reports that tasks and both message types were observed in Chord. Delivery in `https://chat.tsglabs.dev/` has **not** been verified. The supported outbound delivery contract, customer identity mapping, and required authorization for customer-specific delivery remain unresolved. Do not treat a scheduled task or its API response as proof that a customer received a message.

Low inventory alerts use the same configured Chord scheduled-task mechanism and notify the configured pharmacy conversation when stock falls strictly below its threshold. A per-medicine database flag prevents repeat alerts until stock is restored to the threshold or higher. A failed dispatch is logged and its flag is cleared for a later retry. Task creation is not proof of message delivery.

If a Chord request fails, the backend logs the failure and leaves the committed payment/order state intact. There is no persistent outbox, automatic retry, dead-letter queue, or staff alert. Staff must check the Chord task/dashboard and order state and contact the customer through an independently confirmed channel. Duplicate successful payment verification returns early; a repeated pickup transition is rejected by the status guard, so the notification call is not repeated by that request path.

## Deployment and limitations

The Render Blueprint declares the API, PostgreSQL, and required secret environment entries. Configure the values in the service environment; `sync: false` entries are not supplied automatically. Keep Paystack test credentials and fictional customer data in the demo. Use authorized Chord credentials and an explicitly confirmed destination. Back up data before schema changes; `src/db/init.js` applies DDL and legacy status migration at startup. The shared staff key is demo-only.

This is not production-ready. It has no customer-specific conversation mapping, confirmed simulator delivery, notification retry/alerting, production access control, audit trail, rate limiting, cancellation/refund workflow, or operational recovery process. Before real use, a pharmacy and Chord must validate channel binding, consent/privacy and retention, payment credentials, monitoring and alert ownership, database backup/recovery, and supervised order handling. The assistant must refer medical advice to a pharmacist and must not diagnose or prescribe.

## Submission evidence

- [Deployment field notes](deployment-field-notes.md) distinguish repository/commit evidence from unresolved external behavior.
- [Go-live note](go-live-note.md) summarizes owner-facing limitations and launch checks.
- [Recording plan](recording-plan.md) is a timed script only. No screen recording is included in this repository.
