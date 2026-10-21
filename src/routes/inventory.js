const express = require("express");
const pool = require("../db/pool");
const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const query = String(req.query.query || "").trim().toLowerCase();
    const result = query
      ? await pool.query(
          `SELECT id, name, unit, price_ngn, stock FROM inventory
           WHERE LOWER(name) LIKE $1 OR LOWER(id) = $2 ORDER BY name`,
          [`%${query}%`, query]
        )
      : await pool.query("SELECT id, name, unit, price_ngn, stock FROM inventory ORDER BY name");
    res.json({ items: result.rows.map(row => ({ id: row.id, name: row.name, unit: row.unit, priceNgn: Number(row.price_ngn), stock: Number(row.stock) })), count: result.rowCount });
  } catch (error) { next(error); }
});

module.exports = router;
