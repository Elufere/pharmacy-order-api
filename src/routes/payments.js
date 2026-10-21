const express = require("express");
const { verifyPayment } = require("../services/paystack.service");
const router = express.Router();

router.get("/verify/:reference", async (req, res, next) => {
  try {
    const result = await verifyPayment(String(req.params.reference || ""));
    if (result.error) return res.status(result.error.status).json(result.error.body);
    res.json(result.body);
  } catch (error) { next(error); }
});

module.exports = router;
