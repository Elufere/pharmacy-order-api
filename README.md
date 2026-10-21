# Community Pharmacy Demo API

This version uses PostgreSQL so inventory and order records survive service restarts and redeploys. It is designed for the TSG Labs / Chord assessment with fictional data only.

## Endpoints

- `GET /health` — verifies the API and database connection.
- `GET /inventory?query=paracetamol` — search product names or IDs; omit query to list all products.
- `POST /orders` — creates a customer-confirmed order, transactionally validates and decrements stock, and persists order/items.
- `GET /orders/:id` — retrieve an order by UUID or order reference.

## Seed products

| ID | Product | Unit | Price | Initial stock |
|---|---|---|---:|---:|
| `med-001` | Paracetamol 500 mg | pack | ₦1,500 | 20 |
| `supp-001` | Vitamin C | bottle | ₦2,000 | 12 |

Seed records are inserted only when missing. Restarts do not reset existing stock or overwrite prices.

## Create order request

```json
{
  "customerConfirmed": true,
  "items": [
    { "productId": "med-001", "quantity": 2 }
  ]
}
```

Optional request header: `Idempotency-Key: <unique-key>`. Reusing the same key returns the original successful response rather than creating another order.

## Run locally

Requires Node.js 20+ and PostgreSQL.

```bash
npm install
DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/pharmacy_orders' npm start
```

For a local database without TLS, do not add `sslmode=require`. For Render's external database URL, use the supplied URL with `sslmode=require`. For a web service on Render, use the database's internal URL and deploy the database and service in the same region/account.

## Deploy on Render

### Option A: Render Blueprint
1. Push this folder to a GitHub repository.
2. In Render, choose **New → Blueprint** and select the repository containing `render.yaml`.
3. Review the plan and resources, then apply. The Blueprint defines the web service and PostgreSQL database and wires `DATABASE_URL`.
4. Wait for both resources to become available.
5. Open the web service URL with `/health` appended. Expected response: `{"status":"ok","database":"connected","service":"pharmacy-order-api"}`.

### Option B: create resources manually
1. Create a Render PostgreSQL database.
2. Create a Render Web Service from this repository with build command `npm install` and start command `npm start`.
3. Add environment variable `DATABASE_URL` with the database's **Internal Database URL** if the service is in the same Render region/account. Otherwise use the External Database URL with TLS required.
4. Deploy and check `/health`.

## Safeguards

- Rejects requests unless `customerConfirmed` is exactly `true`.
- Validates all product IDs and positive integer quantities.
- Locks product rows in a database transaction and checks current stock before creating an order.
- Decrements stock and writes order/items in the same transaction, avoiding partial orders and overselling.
- Supports a persistent idempotency key to reduce duplicate order creation.
- Stores no customer name, phone number, payment details, or medical data.
- Orders are `awaiting_pharmacy_confirmation`; this API does not claim payment or final pharmacy acceptance.

## Honest limitations

This is an assessment/demo API, not production pharmacy software. It uses fictional products; there is no authentication or authorization on these endpoints, no payment, no prescription validation, no delivery workflow, and no pharmacy staff dashboard. Do not use it with real customer/patient data or expose it as a live pharmacy system. Before any real deployment, add authentication, rate limiting, audit/retention controls, staff authorization, monitoring, backups/recovery checks, and appropriate operational and regulatory review.
