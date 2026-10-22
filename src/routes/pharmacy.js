const express = require("express");
const pool = require("../db/pool");
const requirePharmacyKey = require("../middleware/requirePharmacyKey");
const { getOrderWithItems } = require("../services/order.service");
const { getInvoiceForOrder } = require("../services/invoice.service");
const { sendNotification } = require("../services/chord.service");
const router = express.Router();

router.use(requirePharmacyKey);

router.get("/orders", async (req, res, next) => {
  try {
    const status = String(req.query.status || "all");
    const allowed = ["all", "pending_payment", "payment_confirmed", "ready_for_pickup"];
    if (!allowed.includes(status)) return res.status(400).json({ error: "INVALID_STATUS_FILTER", allowed });
    const result = await pool.query(
      status === "all"
        ? `SELECT id, order_ref FROM orders WHERE status IN ('pending_payment', 'payment_confirmed', 'ready_for_pickup') ORDER BY created_at DESC LIMIT 100`
        : `SELECT id, order_ref FROM orders WHERE status = $1 ORDER BY created_at DESC LIMIT 100`,
      status === "all" ? [] : [status]
    );
    const orders = [];
    for (const row of result.rows) {
      const details = await getOrderWithItems(pool, row.order_ref);
      const invoice = await getInvoiceForOrder(row.id);
      orders.push({ ...details.order, invoice: invoice ? { invoiceRef: invoice.invoice_ref, amountNgn: Number(invoice.amount_ngn), status: invoice.status, paidAt: invoice.paid_at } : null });
    }
    res.json({ count: orders.length, orders });
  } catch (error) { next(error); }
});

router.patch("/orders/:id/status", async (req, res, next) => {
  const targetStatus = req.body?.status;
  if (targetStatus !== "ready_for_pickup") {
    return res.status(400).json({ error: "INVALID_TARGET_STATUS", allowed: ["ready_for_pickup"] });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT id, order_ref, status FROM orders WHERE id::text = $1 OR order_ref = $1 FOR UPDATE",
      [req.params.id]
    );
    if (!current.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "ORDER_NOT_FOUND" }); }
    const order = current.rows[0];
    if (order.status !== "payment_confirmed") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "INVALID_STATUS_TRANSITION", currentStatus: order.status, requestedStatus: targetStatus, allowedNextStatuses: order.status === "payment_confirmed" ? ["ready_for_pickup"] : [] });
    }
    const invoice = await client.query("SELECT status FROM invoices WHERE order_id = $1 FOR UPDATE", [order.id]);
    if (!invoice.rowCount || invoice.rows[0].status !== "paid") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "PAYMENT_NOT_CONFIRMED", message: "Only orders with a verified paid invoice can be marked ready for pickup." });
    }
    const updated = await client.query(
      "UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1 AND status = 'payment_confirmed' RETURNING order_ref, status, updated_at",
      [order.id, targetStatus]
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "INVALID_STATUS_TRANSITION", message: "The order status changed before the update could be applied." });
    }
    await client.query("COMMIT");

    try {
      await sendNotification("ready_for_pickup", updated.rows[0].order_ref);
    } catch (error) {
      console.error("Chord pickup notification dispatch failed", {
        eventType: "ready_for_pickup",
        orderRef: updated.rows[0].order_ref,
        error: error?.message || "Notification failed",
      });
    }

    return res.json({
      orderRef: updated.rows[0].order_ref,
      status: updated.rows[0].status,
      updatedAt: updated.rows[0].updated_at,
    });

  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    next(error);
  } finally { client.release(); }
});

module.exports = router;
