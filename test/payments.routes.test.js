const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

function loadPaymentRoutes(initializePayment) {
  const servicePath = require.resolve("../src/services/paystack.service");
  const routePath = require.resolve("../src/routes/payments");
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: { initializePayment, verifyPayment: async () => ({ body: {} }) }
  };
  delete require.cache[routePath];
  const router = require(routePath);
  return router.stack.find(layer => layer.route?.path === "/initialize" && layer.route.methods.post).route.stack[0].handle;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function loadWebhookRoute(verifyPayment) {
  const servicePath = require.resolve("../src/services/paystack.service");
  const routePath = require.resolve("../src/routes/payments");
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: { initializePayment: async () => ({}), verifyPayment }
  };
  delete require.cache[routePath];
  const router = require(routePath);
  return router.stack.find(layer => layer.route?.path === "/webhook" && layer.route.methods.post).route.stack[0].handle;
}

const webhookSecret = "webhook-test-secret";
function signedRequest(body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac("sha512", webhookSecret).update(rawBody).digest("hex");
  return { headers: { "x-paystack-signature": signature }, rawBody, body };
}

test("webhook accepts a valid signature and delegates the reference to server-side verification", async () => {
  process.env.PAYSTACK_SECRET_KEY = webhookSecret;
  const calls = [];
  const handler = loadWebhookRoute(async (...args) => {
    calls.push(args);
    return { body: { paymentStatus: "success", invoiceStatus: "paid", orderStatus: "payment_confirmed" } };
  });
  const req = signedRequest({ event: "charge.success", data: { reference: "ph-test" } });
  const res = response();
  await handler({ ...req, header: name => req.headers[name] }, res, error => { throw error; });
  assert.deepEqual(calls, [["ph-test", { recordFailure: false }]]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orderStatus, "payment_confirmed");
});

test("webhook rejects an invalid signature without calling verification", async () => {
  process.env.PAYSTACK_SECRET_KEY = webhookSecret;
  let calls = 0;
  const handler = loadWebhookRoute(async () => { calls++; });
  const req = signedRequest({ event: "charge.success", data: { reference: "ph-test" } });
  req.headers["x-paystack-signature"] = "0".repeat(128);
  const res = response();
  await handler({ ...req, header: name => req.headers[name] }, res, error => { throw error; });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "INVALID_WEBHOOK_SIGNATURE");
  assert.equal(calls, 0);
});

test("webhook returns verification failures without treating them as success", async () => {
  process.env.PAYSTACK_SECRET_KEY = webhookSecret;
  const handler = loadWebhookRoute(async () => ({ error: { status: 502, body: { error: "PAYMENT_VERIFICATION_FAILED" } } }));
  const req = signedRequest({ event: "charge.success", data: { reference: "ph-test" } });
  const res = response();
  await handler({ ...req, header: name => req.headers[name] }, res, error => { throw error; });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "PAYMENT_VERIFICATION_FAILED");
});

test("webhook rejects verified amount and currency mismatches", async () => {
  process.env.PAYSTACK_SECRET_KEY = webhookSecret;
  for (const mismatch of ["amount", "currency"]) {
    const handler = loadWebhookRoute(async () => ({ error: { status: 409, body: { error: "PAYMENT_NOT_VERIFIED", mismatch } } }));
    const req = signedRequest({ event: "charge.success", data: { reference: "ph-test" } });
    const res = response();
    await handler({ ...req, header: name => req.headers[name] }, res, error => { throw error; });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.mismatch, mismatch);
  }
});

test("webhook acknowledges unrelated event types without changing payment state", async () => {
  process.env.PAYSTACK_SECRET_KEY = webhookSecret;
  let calls = 0;
  const handler = loadWebhookRoute(async () => { calls++; });
  const req = signedRequest({ event: "transfer.success", data: { reference: "ph-test" } });
  const res = response();
  await handler({ ...req, header: name => req.headers[name] }, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, true);
  assert.equal(calls, 0);
});

test("duplicate webhook deliveries rely on idempotent verification and are acknowledged", async () => {
  process.env.PAYSTACK_SECRET_KEY = webhookSecret;
  let calls = 0;
  const handler = loadWebhookRoute(async () => {
    calls++;
    return { body: { paymentStatus: "success", invoiceStatus: "paid", orderStatus: "payment_confirmed", message: "Payment was already verified." } };
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const req = signedRequest({ event: "charge.success", data: { reference: "ph-test" } });
    const res = response();
    await handler({ ...req, header: name => req.headers[name] }, res, error => { throw error; });
    assert.equal(res.statusCode, 200);
  }
  assert.equal(calls, 2);
});

test("payment initialization route validates order reference", async () => {
  let called = false;
  const handler = loadPaymentRoutes(async () => { called = true; });
  const res = response();
  await handler({ body: { email: "customer@example.com" } }, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "ORDER_REFERENCE_REQUIRED");
  assert.equal(called, false);
});

for (const email of [undefined, "bad-email"]) {
  test(`payment initialization route rejects invalid email (${email || "missing"})`, async () => {
    let called = false;
    const handler = loadPaymentRoutes(async () => { called = true; });
    const res = response();
    await handler({ body: { orderRef: "PH-123", email } }, res, error => { throw error; });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "VALID_EMAIL_REQUIRED");
    assert.equal(called, false);
  });
}

test("payment initialization route calls service and returns successful status and body", async () => {
  const calls = [];
  const body = { orderRef: "PH-123", checkoutUrl: "https://checkout.example", paymentStatus: "pending" };
  const handler = loadPaymentRoutes(async (...args) => { calls.push(args); return { status: 201, body }; });
  const res = response();
  await handler({ body: { orderRef: " PH-123 ", email: " CUSTOMER@EXAMPLE.COM " } }, res, error => { throw error; });
  assert.deepEqual(calls, [["PH-123", "customer@example.com"]]);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, body);
});

test("payment initialization route returns service errors", async () => {
  const serviceError = { error: "ORDER_NOT_PAYABLE", message: "Only pending payment orders can initialize checkout." };
  const handler = loadPaymentRoutes(async () => ({ error: { status: 409, body: serviceError } }));
  const res = response();
  await handler({ body: { orderRef: "PH-123", email: "customer@example.com" } }, res, error => { throw error; });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, serviceError);
});

test("payment initialization route forwards unexpected service errors", async () => {
  const failure = new Error("service failed");
  const handler = loadPaymentRoutes(async () => { throw failure; });
  let forwarded;
  await handler({ body: { orderRef: "PH-123", email: "customer@example.com" } }, response(), error => { forwarded = error; });
  assert.equal(forwarded, failure);
});
