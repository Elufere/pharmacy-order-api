const crypto = require("node:crypto");
const pool = require("../db/pool");
const { getOrderWithItems } = require("./order.service");
const { getInvoiceForOrder } = require("./invoice.service");
const { sendNotification } = require("./chord.service");

const secretKey = () => process.env.PAYSTACK_SECRET_KEY || "";

async function initializePayment(idOrRef, email) {
  if (!secretKey()) return { error: { status: 503, body: { error: "PAYMENTS_NOT_CONFIGURED", message: "Paystack test payments are not configured on this service." } } };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: { status: 400, body: { error: "VALID_EMAIL_REQUIRED", message: "A valid email address is required to initialize Paystack checkout." } } };

  const orderResult = await getOrderWithItems(pool, idOrRef);
  if (!orderResult) return { error: { status: 404, body: { error: "ORDER_NOT_FOUND", message: "No order was found for that reference." } } };
  if (orderResult.order.status !== "pending_payment") {
    return {
      error: {
        status: 409,
        body: {
          error: "ORDER_NOT_PAYABLE",
          message: "Only orders awaiting payment can initialize checkout."
        }
      }
    };
  }
  const invoice = await getInvoiceForOrder(orderResult.row.id);
  if (!invoice) return { error: { status: 404, body: { error: "INVOICE_NOT_FOUND", message: "No invoice exists for this order." } } };
  if (invoice.status !== "unpaid") return { error: { status: 409, body: { error: invoice.status === "paid" ? "ALREADY_PAID" : "INVOICE_NOT_PAYABLE", message: "Only unpaid invoices can initialize checkout." } } };

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

async function verifyPayment(reference, { recordFailure = true } = {}) {
  if (!secretKey()) return { error: { status: 503, body: { error: "PAYMENTS_NOT_CONFIGURED", message: "Paystack test payments are not configured on this service." } } };
  const paymentResult = await pool.query(
    `SELECT p.id, p.invoice_id, p.reference, p.amount_kobo, p.status, i.order_id, i.amount_ngn, i.status AS invoice_status, o.order_ref, o.status AS order_status
     FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN orders o ON o.id = i.order_id WHERE p.reference = $1`,
    [reference]
  );
  if (!paymentResult.rowCount) return { error: { status: 404, body: { error: "PAYMENT_NOT_FOUND", message: "No payment attempt was found for that reference." } } };
  const payment = paymentResult.rows[0];
  if (payment.status === "success" && payment.invoice_status === "paid" && ["payment_confirmed", "ready_for_pickup"].includes(payment.order_status)) return { body: { paymentStatus: "success", invoiceStatus: "paid", orderStatus: payment.order_status, reference, message: "Payment was already verified." } };

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

      const lockedOrder = await client.query(
        `SELECT id, status
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [payment.order_id]
      );

      if (!lockedOrder.rowCount) {
        await client.query("ROLLBACK");
        return {
          error: {
            status: 404,
            body: {
              error: "ORDER_NOT_FOUND",
              message: "The order associated with this payment no longer exists."
            }
          }
        };
      }

      const order = lockedOrder.rows[0];

      if (!["pending_payment", "payment_confirmed"].includes(order.status)) {
        await client.query("ROLLBACK");
        return {
          error: {
            status: 409,
            body: {
              error: "INVALID_ORDER_STATUS",
              currentStatus: order.status,
              message: "Payment succeeded, but the order needs staff review before its status can change."
            }
          }
        };
      }

      const paymentUpdate = await client.query(
        `UPDATE payments
         SET status = 'success',
             provider_transaction_id = $2,
             verified_at = NOW()
         WHERE id = $1 AND status <> 'success'
         RETURNING id`,
        [payment.id, String(transaction.id)]
      );
      if (payment.status !== "success" && paymentUpdate.rowCount !== 1) throw new Error("Payment record was not updated during verification.");

      const orderLines = await client.query(
        `SELECT product_id, SUM(quantity)::INTEGER AS quantity
         FROM order_items WHERE order_id = $1 GROUP BY product_id ORDER BY product_id`,
        [payment.order_id]
      );
      const productIds = orderLines.rows.map(row => row.product_id);
      const lockedInventory = await client.query(
        `SELECT id, name, stock, low_stock_threshold, low_stock_alerted
         FROM inventory WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
        [productIds]
      );
      const inventoryById = new Map(lockedInventory.rows.map(row => [row.id, row]));
      for (const line of orderLines.rows) {
        const medicine = inventoryById.get(line.product_id);
        if (!medicine || Number(line.quantity) > Number(medicine.stock)) {
          await client.query("ROLLBACK");
          return { error: { status: 409, body: {
            error: "INSUFFICIENT_STOCK_AFTER_PAYMENT",
            productId: line.product_id,
            requested: Number(line.quantity),
            available: Number(medicine?.stock || 0),
            message: "Paystack reports successful payment, but available stock changed before it could be committed. Contact the pharmacy for resolution."
          } } };
        }
      }

      const lowStockAlerts = [];
      if (order.status === "pending_payment") {
        for (const line of orderLines.rows) {
          const medicine = inventoryById.get(line.product_id);
          const deduction = await client.query(`UPDATE inventory SET stock = stock - $1, updated_at = NOW(),
            low_stock_alerted = CASE WHEN stock - $1 < low_stock_threshold THEN TRUE ELSE FALSE END
            WHERE id = $2 AND stock >= $1 RETURNING id, name, stock, low_stock_threshold`, [Number(line.quantity), line.product_id]);
          if (deduction.rowCount !== 1) throw new Error(`Inventory deduction failed for ${line.product_id}.`);
          const updated = deduction.rows[0];
          if (Number(updated.stock) < Number(updated.low_stock_threshold) && !medicine.low_stock_alerted) lowStockAlerts.push(updated);
        }
      }

      const invoiceUpdate = await client.query(
        `UPDATE invoices
         SET status = 'paid',
             paid_at = COALESCE(paid_at, NOW())
         WHERE id = $1 AND amount_ngn * 100 = $2 AND status IN ('unpaid', 'paid')
         RETURNING id`,
        [payment.invoice_id, payment.amount_kobo]
      );
      if (invoiceUpdate.rowCount !== 1) throw new Error("Invoice amount or record did not match the verified payment.");

      const orderUpdate = await client.query(
        `UPDATE orders
         SET status = 'payment_confirmed',
             updated_at = NOW()
         WHERE id = $1 AND status IN ('pending_payment', 'payment_confirmed')
         RETURNING id`,
        [payment.order_id]
      );
      if (orderUpdate.rowCount !== 1) throw new Error("Order was not updated during payment verification.");

      await client.query("COMMIT");

      if (payment.status !== "success") {
        try {
          await sendNotification("payment_confirmed", payment.order_ref);
        } catch (error) {
          console.error("Chord payment notification dispatch failed", {
            eventType: "payment_confirmed",
            orderRef: payment.order_ref,
            error: error?.message || "Notification failed",
          });
        }
      }

      for (const item of lowStockAlerts) {
        try { await sendNotification("low_inventory", item.id, { name: item.name, stock: Number(item.stock), threshold: Number(item.low_stock_threshold) }); }
        catch (error) {
          console.error("Chord low inventory notification dispatch failed", { medicineId: item.id, error: error?.message || "Notification failed" });
          try { await pool.query("UPDATE inventory SET low_stock_alerted = FALSE WHERE id = $1 AND stock < low_stock_threshold", [item.id]); }
          catch (resetError) { console.error("Low inventory alert state reset failed", { medicineId: item.id, error: resetError?.message || "Reset failed" }); }
        }
      }

      return {
        body: {
          paymentStatus: "success",
          invoiceStatus: "paid",
          orderStatus: "payment_confirmed",
          reference,
          amountNgn: Number(payment.amount_ngn),
          currency: "NGN",
          message: "Paystack payment verified successfully."
        }
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}

      throw error;
    } finally {
      client.release();
    }
  }


  const status = transaction.status === "abandoned" ? "abandoned" : "failed";
  if (recordFailure) {
    await pool.query("UPDATE payments SET status = $2, verified_at = NOW() WHERE id = $1 AND status <> 'success'", [payment.id, status]);
  }
  return { error: { status: 409, body: {
    paymentStatus: status, invoiceStatus: "unpaid", reference,
    checks: { transactionStatus: transaction.status, amountMatches, currencyMatches, referenceMatches },
    message: "Payment was not verified as a successful transaction for the expected amount and currency. The invoice remains unpaid."
  }}};
}

module.exports = { initializePayment, verifyPayment };
