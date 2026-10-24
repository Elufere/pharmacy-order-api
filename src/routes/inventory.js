const express = require("express");
const pool = require("../db/pool");
const requirePharmacyKey = require("../middleware/requirePharmacyKey");
const { sendNotification } = require("../services/chord.service");
const router = express.Router();

function maybeNotifyLowStock(row) {
  if (Number(row.stock) >= Number(row.low_stock_threshold) || row.low_stock_alerted) return;
  pool.query("UPDATE inventory SET low_stock_alerted = TRUE WHERE id = $1 AND low_stock_alerted = FALSE AND stock < low_stock_threshold RETURNING id", [row.id])
    .then(result => {
      if (result.rowCount) return sendNotification("low_inventory", row.id, { name: row.name, stock: Number(row.stock), threshold: Number(row.low_stock_threshold) });
    })
    .catch(async error => {
      console.error("Chord low inventory notification dispatch failed", { medicineId: row.id, error: error?.message || "Notification failed" });
      try { await pool.query("UPDATE inventory SET low_stock_alerted = FALSE WHERE id = $1 AND stock < low_stock_threshold", [row.id]); }
      catch (resetError) { console.error("Low inventory alert state reset failed", { medicineId: row.id, error: resetError?.message || "Reset failed" }); }
    });
}

router.post("/", requirePharmacyKey, async (req, res, next) => {
  const { id, name, unit, priceNgn, stock, lowStockThreshold } = req.body || {};
  if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim() || typeof unit !== "string" || !unit.trim() || !Number.isSafeInteger(priceNgn) || priceNgn < 0 || !Number.isSafeInteger(stock) || stock < 0 || !Number.isSafeInteger(lowStockThreshold) || lowStockThreshold < 0) {
    return res.status(400).json({ error: "INVALID_INVENTORY_ITEM", message: "Provide id, name, unit, non-negative whole-number priceNgn, stock, and lowStockThreshold." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO inventory (id, name, unit, price_ngn, stock, low_stock_threshold)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, name, unit, price_ngn, stock, low_stock_threshold, low_stock_alerted`,
      [id.trim(), name.trim(), unit.trim(), priceNgn, stock, lowStockThreshold]
    );
    if (!result.rowCount) return res.status(409).json({ error: "DUPLICATE_MEDICINE", message: "An inventory item with this id already exists." });
    maybeNotifyLowStock(result.rows[0]);
    const row = result.rows[0];
    return res.status(201).json({ id: row.id, name: row.name, unit: row.unit, priceNgn: Number(row.price_ngn), stock: Number(row.stock), lowStockThreshold: Number(row.low_stock_threshold) });
  } catch (error) { next(error); }
});

router.post("/:id/top-up", requirePharmacyKey, async (req, res, next) => {
  const quantity = req.body?.quantity;
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return res.status(400).json({ error: "INVALID_QUANTITY", message: "quantity must be a positive whole number." });
  try {
    const result = await pool.query(
      `UPDATE inventory SET stock = stock + $1, updated_at = NOW(),
         low_stock_alerted = CASE WHEN stock + $1 >= low_stock_threshold THEN FALSE ELSE low_stock_alerted END
       WHERE id = $2 RETURNING id, name, stock, low_stock_threshold, low_stock_alerted`,
      [quantity, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "PRODUCT_NOT_FOUND", message: "No inventory item was found for that id." });
    const row = result.rows[0];
    maybeNotifyLowStock(row);
    return res.json({ id: row.id, name: row.name, stock: Number(row.stock) });
  } catch (error) { next(error); }
});

router.get("/", async (req, res, next) => {
  try {
    const query = String(req.query.query || "").trim().toLowerCase();
    const result = query
      ? await pool.query(
          `SELECT id, name, unit, price_ngn, stock, low_stock_threshold FROM inventory
           WHERE LOWER(name) LIKE $1 OR LOWER(id) = $2 ORDER BY name`,
          [`%${query}%`, query]
        )
      : await pool.query("SELECT id, name, unit, price_ngn, stock, low_stock_threshold FROM inventory ORDER BY name");
    res.json({ items: result.rows.map(row => ({ id: row.id, name: row.name, unit: row.unit, priceNgn: Number(row.price_ngn), stock: Number(row.stock), lowStockThreshold: Number(row.low_stock_threshold) })), count: result.rowCount });
  } catch (error) { next(error); }
});

module.exports = router;
