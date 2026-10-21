const express = require("express");
const pool = require("./db/pool");
const initializeDatabase = require("./db/init");

const healthRoutes = require("./routes/health");
const inventoryRoutes = require("./routes/inventory");
const orderRoutes = require("./routes/orders");
const paymentRoutes = require("./routes/payments");
const pharmacyRoutes = require("./routes/pharmacy");

const app = express();
app.use(express.json({
  limit: "32kb",
  verify(req, _res, buffer) {
    if (req.originalUrl.split("?", 1)[0] === "/payments/webhook") req.rawBody = Buffer.from(buffer);
  }
}));

app.get("/", (_req, res) => res.json({
  service: "Community Pharmacy Demo API",
  status: "ok",
  endpoints: [
    "GET /health",
    "GET /inventory?query=paracetamol",
    "POST /orders",
    "GET /orders/:id",
    "GET /orders/:id/invoice",
    "POST /orders/:id/payment",
    "POST /payments/initialize",
    "POST /payments/webhook",
    "GET /payments/verify/:reference",
    "GET /pharmacy/orders?status=all",
    "PATCH /pharmacy/orders/:id/status"
  ]
}));

app.use("/health", healthRoutes);
app.use("/inventory", inventoryRoutes);
app.use("/orders", orderRoutes);
app.use("/payments", paymentRoutes);
app.use("/pharmacy", pharmacyRoutes);

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: "INVALID_JSON", message: "Request body must be valid JSON." });
  console.error(err);
  res.status(500).json({ error: "INTERNAL_ERROR", message: "Unexpected server error." });
});

const port = Number(process.env.PORT || 3000);
let server;
initializeDatabase()
  .then(() => { server = app.listen(port, "0.0.0.0", () => console.log(`Pharmacy demo API listening on port ${port}`)); })
  .catch(error => { console.error("Database initialization failed:", error); process.exit(1); });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server) await new Promise(resolve => server.close(resolve));
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
