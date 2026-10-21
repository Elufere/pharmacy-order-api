const express = require("express");
const pool = require("../db/pool");
const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected", service: "pharmacy-order-api", paystackConfigured: Boolean(process.env.PAYSTACK_SECRET_KEY) });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

module.exports = router;
