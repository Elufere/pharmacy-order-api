function requirePharmacyKey(req, res, next) {
  const configuredKey = process.env.PHARMACY_API_KEY || "";
  if (!configuredKey) {
    return res.status(503).json({
      error: "PHARMACY_ACCESS_NOT_CONFIGURED",
      message: "Set PHARMACY_API_KEY in the service environment before using pharmacy staff endpoints."
    });
  }
  const supplied = req.header("x-pharmacy-api-key");
  if (!supplied || supplied !== configuredKey) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "Valid pharmacy staff credentials are required." });
  }
  next();
}

module.exports = requirePharmacyKey;
