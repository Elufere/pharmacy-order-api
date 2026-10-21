const crypto = require("node:crypto");
const pool = require("../db/pool");
const { getOrderWithItems } = require("./order.service");
const { getInvoiceForOrder } = require("./invoice.service");

const secretKey = () => process.env.PAYSTACK_SECRET_KEY || "";

async function initializePayment(idOrRef, email) {
  if (!secretKey()) return { error: { status: 503, body: { error: "PAYMENTS_NOT_CONFIGURED", message: "Paystack test payments are not configured on this service." } } };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: { status: 400, body: { error: "VALID_EMAIL_REQUIRED", message: "A valid email address is required to initialize Paystack checkout." } } };

  const orderResult = await getOrderWithItems(pool, idOrRef);
  if (!orderResult) return { error: { status: 404, body: { error: "ORDER_NOT_FOUND", message: "No order was found for that reference." } } };
  if (orderResult.order.status === "rejected") return { error: { status: 409, body: { error: "ORDER_NOT_PAYABLE", message: "Rejected orders cannot be paid." } } };
  const invoice = await getInvoiceForOrder(orderResult.row.id);
  if (!invoice) return { error: { status: 404, body: { error: "INVOICE_NOT_FOUND", message: "No invoice exists for this order." } } };
  if (invoice.status === "paid") return { error: { status: 409, body: { error: "ALREADY_PAID", message: "This invoice has already been paid." } } };

  const reference = `ph_${crypto.randomUUID().replace(/-/g, "")}`;
  const amountKobo = Number(invoice.amount_ngn) * 100;
  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, amount: String(amountKobo), currency: "NGN", reference, metadata: { orderRef: invoice.order_ref, invoiceRef: invoice.invoice_ref } }),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.status || !payload?.data?.authorization_url || !payload?.data?.reference) {
    console.error("Paystack initialization failed:", payload?.message || response.status);
    return { error: { status: 502, body: { error: "PAYMENT_INITIALIZATION_FAILED", message: "Paystack could not initialize checkout. No payment has been confirmed; retry or contact the pharmacy." } } };
  }

  await pool.query(
    `INSERT INTO payments (id, invoice_id, reference, amount_kobo, status, authorization_url)
     VALUES ($1, $2, $3, $4, 'pending', $5)`,
    [crypto.randomUUID(), invoice.id, payload.data.reference, amountKobo, payload.data.authorization_url]
  );
  await pool.query("UPDATE orders SET customer_email = COALESCE(customer_email, $2), updated_at = NOW() WHERE id = $1", [orderResult.row.id, email]);
  return { status: 201, body: {
    orderRef: invoice.order_ref,
    invoiceRef: invoice.invoice_ref,
    paymentReference: payload.data.reference,
    amountNgn: Number(invoice.amount_ngn),
    currency: "NGN",
    paymentStatus: "pending",
    checkoutUrl: payload.data.authorization_url,
    message: "Open the checkout URL to complete the test payment. The order is not marked paid until verification succeeds."
  }};
}

async function verifyPayment(reference) {
  if (!secretKey()) return { error: { status: 503, body: { error: "PAYMENTS_NOT_CONFIGURED", message: "Paystack test payments are not configured on this service." } } };
  const paymentResult = await pool.query(
    `SELECT p.id, p.invoice_id, p.reference, p.amount_kobo, p.status, i.order_id, i.amount_ngn, i.status AS invoice_status
     FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.reference = $1`,
    [reference]
  );
  if (!paymentResult.rowCount) return { error: { status: 404, body: { error: "PAYMENT_NOT_FOUND", message: "No payment attempt was found for that reference." } } };
  const payment = paymentResult.rows[0];
  if (payment.status === "success" && payment.invoice_status === "paid") return { body: { paymentStatus: "success", invoiceStatus: "paid", reference, message: "Payment was already verified." } };

  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey()}` },
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.status || !payload?.data) {
    console.error("Paystack verification failed:", payload?.message || response.status);
    return { error: { status: 502, body: { error: "PAYMENT_VERIFICATION_FAILED", message: "Could not verify payment with Paystack. The invoice remains unpaid until verification succeeds." } } };
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
      await client.query("UPDATE payments SET status = 'success', provider_transaction_id = $2, verified_at = NOW() WHERE id = $1", [payment.id, String(transaction.id)]);
      await client.query("UPDATE invoices SET status = 'paid', paid_at = NOW() WHERE id = $1", [payment.invoice_id]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    return { body: { paymentStatus: "success", invoiceStatus: "paid", reference, amountNgn: Number(payment.amount_ngn), currency: "NGN", message: "Paystack payment verified successfully." } };
  }

  const status = transaction.status === "abandoned" ? "abandoned" : "failed";
  await pool.query("UPDATE payments SET status = $2, verified_at = NOW() WHERE id = $1 AND status <> 'success'", [payment.id, status]);
  return { error: { status: 409, body: {
    paymentStatus: status, invoiceStatus: "unpaid", reference,
    checks: { transactionStatus: transaction.status, amountMatches, currencyMatches, referenceMatches },
    message: "Payment was not verified as a successful transaction for the expected amount and currency. The invoice remains unpaid."
  }}};
}

module.exports = { initializePayment, verifyPayment };
