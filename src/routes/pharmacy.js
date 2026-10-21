const express = require("express");
const pool = require("../db/pool");
const requirePharmacyKey = require("../middleware/requirePharmacyKey");
const { getOrderWithItems } = require("../services/order.service");
const { getInvoiceForOrder } = require("../services/invoice.service");
const router = express.Router();

router.use(requirePharmacyKey);

router.get("/orders", async (req, res, next) => {
  try {
    const status = String(req.query.status || "awaiting_pharmacy_confirmation");
    const allowed = ["awaiting_pharmacy_confirmation", "confirmed", "rejected", "ready_for_pickup"];
    if (!allowed.includes(status)) return res.status(400).json({ error: "INVALID_STATUS_FILTER", allowed });
    const result = await pool.query(
      `SELECT id, order_ref FROM orders WHERE status = $1 ORDER BY created_at ASC LIMIT 100`, [status]
    );
    const orders = [];
    for (const row of result.rows) {
      const details = await getOrderWithItems(pool, row.order_ref);
      const invoice = await getInvoiceForOrder(row.id);
      orders.push({ ...details.order, invoice: invoice ? { invoiceRef: invoice.invoice_ref, status: invoice.status } : null });
    }
    res.json({ count: orders.length, orders });
  } catch (error) { next(error); }
});

router.patch("/orders/:id/status", async (req, res, next) => {
  const targetStatus = req.body?.status;
  if (!["confirmed", "rejected", "ready_for_pickup"].includes(targetStatus)) {
    return res.status(400).json({ error: "INVALID_TARGET_STATUS", allowed: ["confirmed", "rejected", "ready_for_pickup"] });
  }
  const transitions = {
    awaiting_pharmacy_confirmation: ["confirmed", "rejected"],
    confirmed: ["ready_for_pickup"],
    ready_for_pickup: [],
    rejected: []
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT id, order_ref, status FROM orders WHERE id::text = $1 OR order_ref = $1 FOR UPDATE",
      [req.params.id]
    );
    if (!current.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "ORDER_NOT_FOUND" }); }
    const order = current.rows[0];
    if (!transitions[order.status]?.includes(targetStatus)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "INVALID_STATUS_TRANSITION", currentStatus: order.status, requestedStatus: targetStatus, allowedNextStatuses: transitions[order.status] || [] });
    }
    const updated = await client.query(
      "UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING order_ref, status, updated_at",
      [order.id, targetStatus]
    );
    await client.query("COMMIT");
    res.json({ orderRef: updated.rows[0].order_ref, status: updated.rows[0].status, updatedAt: updated.rows[0].updated_at });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    next(error);
  } finally { client.release(); }
});

module.exports = router;
