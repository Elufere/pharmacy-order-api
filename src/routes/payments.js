const express = require("express");
const crypto = require("node:crypto");
const { initializePayment, verifyPayment } = require("../services/paystack.service");
const router = express.Router();

function validPaystackSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== "string" || !secret) return false;
  if (!/^[a-f\d]{128}$/i.test(signature)) return false;
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest();
  const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

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

router.post("/webhook", async (req, res, next) => {
  const secret = process.env.PAYSTACK_SECRET_KEY || "";
  const signature = req.header("x-paystack-signature");
  if (!secret) return res.status(503).json({ error: "PAYMENTS_NOT_CONFIGURED" });
  if (!validPaystackSignature(req.rawBody, signature, secret)) {
    return res.status(401).json({ error: "INVALID_WEBHOOK_SIGNATURE" });
  }

  if (req.body?.event !== "charge.success") return res.status(200).json({ received: true, ignored: true });
  const reference = req.body?.data?.reference;
  if (typeof reference !== "string" || !reference.trim()) {
    return res.status(400).json({ error: "WEBHOOK_REFERENCE_REQUIRED" });
  }

  try {
    const result = await verifyPayment(reference, { recordFailure: false });
    if (result.error) return res.status(result.error.status).json(result.error.body);
    res.status(200).json({ received: true, ...result.body });
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
