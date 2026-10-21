const pool = require("../db/pool");
const { getOrderWithItems } = require("./order.service");

async function getInvoiceForOrder(orderId) {
  const result = await pool.query(
    `SELECT i.id, i.invoice_ref, i.order_id, i.amount_ngn, i.status, i.created_at, i.paid_at,
            o.order_ref, o.status AS order_status
     FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.order_id = $1`,
    [orderId]
  );
  return result.rows[0] || null;
}

async function getInvoiceDetails(idOrRef) {
  const orderResult = await getOrderWithItems(pool, idOrRef);
  if (!orderResult) return { error: { status: 404, body: { error: "ORDER_NOT_FOUND", message: "No order was found for that reference." } } };
  const invoice = await getInvoiceForOrder(orderResult.row.id);
  if (!invoice) return { error: { status: 404, body: { error: "INVOICE_NOT_FOUND", message: "No invoice exists for this order." } } };
  return { invoice: {
    invoiceRef: invoice.invoice_ref,
    orderRef: invoice.order_ref,
    issuedAt: invoice.created_at,
    amountNgn: Number(invoice.amount_ngn),
    status: invoice.status,
    paidAt: invoice.paid_at,
    currency: "NGN",
    items: orderResult.order.items,
    note: "Demo invoice. Payment is not confirmed until the server verifies a successful Paystack transaction."
  }};
}

module.exports = { getInvoiceForOrder, getInvoiceDetails };
