const express = require("express");
const { initializePayment, verifyPayment } = require("../services/paystack.service");
const router = express.Router();

router.post("/initialize", async (req, res, next) => {
  const orderRef = typeof req.body?.orderRef === "string" ? req.body.orderRef.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

  if (!orderRef) {
    return res.status(400).json({ error: "ORDER_REFERENCE_REQUIRED", message: "A valid order reference is required to initialize payment." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "VALID_EMAIL_REQUIRED", message: "A valid email address is required to initialize Paystack checkout." });
  }

  try {
    const result = await initializePayment(orderRef, email);
    if (result.error) return res.status(result.error.status).json(result.error.body);
    res.status(result.status || 200).json(result.body);
  } catch (error) { next(error); }
});

router.get("/verify/:reference", async (req, res, next) => {
  try {
    const result = await verifyPayment(String(req.params.reference || ""));
    if (result.error) return res.status(result.error.status).json(result.error.body);
    res.json(result.body);
  } catch (error) { next(error); }
});

module.exports = router;
