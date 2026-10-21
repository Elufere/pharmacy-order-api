function orderDto(orderRow, itemRows) {
  return {
    id: orderRow.id,
    orderRef: orderRow.order_ref,
    status: orderRow.status,
    customerEmail: orderRow.customer_email || undefined,
    createdAt: orderRow.created_at,
    updatedAt: orderRow.updated_at || orderRow.created_at,
    items: itemRows.map(row => ({
      productId: row.product_id,
      productName: row.product_name,
      unit: row.unit,
      quantity: Number(row.quantity),
      unitPriceNgn: Number(row.unit_price_ngn),
      lineTotalNgn: Number(row.line_total_ngn)
    })),
    totalNgn: Number(orderRow.total_ngn)
  };
}

module.exports = orderDto;
