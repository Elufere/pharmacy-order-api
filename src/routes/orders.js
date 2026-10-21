const express = require("express");
const crypto = require("node:crypto");
const pool = require("../db/pool");
const { createOrder, getOrderWithItems } = require("../services/order.service");
const { getInvoiceForOrder, getInvoiceDetails } = require("../services/invoice.service");
const { initializePayment } = require("../services/paystack.service");
const router = express.Router();

router.post("/", async (req, res, next) => {
  const { customerConfirmed, items } = req.body || {};
  const customerEmail = typeof req.body?.customerEmail === "string" ? req.body.customerEmail.trim().toLowerCase() : null;
  const idempotencyKey = String(req.header("Idempotency-Key") || "").trim();

  if (customerConfirmed !== true) return res.status(400).json({ error: "CUSTOMER_CONFIRMATION_REQUIRED", message: "The customer must explicitly confirm the final order before it can be created." });
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) return res.status(400).json({ error: "INVALID_ITEMS", message: "Provide between 1 and 10 order items." });
  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return res.status(400).json({ error: "INVALID_EMAIL", message: "Provide a valid customer email address." });
  for (const item of items) {
    if (!item || typeof item.productId !== "string" || !item.productId.trim() || !Number.isInteger(item.quantity) || item.quantity <= 0) {
      return res.status(400).json({ error: "INVALID_ITEM", message: "Each item requires a productId and a positive whole-number quantity." });
    }
  }

  try {
    const result = await createOrder({ items, customerEmail, idempotencyKey });
    if (result.error) return res.status(result.error.status).json(result.error.body);
    if (result.conflict) return res.status(409).json({ error: "IDEMPOTENCY_CONFLICT", message: "This idempotency key is already being processed. Retry shortly with the same key." });
    res.status(result.status || 200).json(result.response);
  } catch (error) { next(error); }
});

router.get("/:id/invoice", async (req, res, next) => {
  try {
    const result = await getInvoiceDetails(req.params.id);
    if (result.error) return res.status(result.error.status).json(result.error.body);
    res.json(result.invoice);
  } catch (error) { next(error); }
});

router.post("/:id/payment", async (req, res, next) => {
  try {
    const result = await initializePayment(req.params.id, String(req.body?.email || "").trim().toLowerCase());
    if (result.error) return res.status(result.error.status).json(result.error.body);
    res.status(result.status || 200).json(result.body);
  } catch (error) { next(error); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const result = await getOrderWithItems(pool, req.params.id);
    if (!result) return res.status(404).json({ error: "ORDER_NOT_FOUND", message: "No order was found for that reference." });
    const invoice = await getInvoiceForOrder(result.row.id);
    res.json({ ...result.order, invoice: invoice ? { invoiceRef: invoice.invoice_ref, amountNgn: Number(invoice.amount_ngn), status: invoice.status, paidAt: invoice.paid_at } : null });
  } catch (error) { next(error); }
});

module.exports = router;
