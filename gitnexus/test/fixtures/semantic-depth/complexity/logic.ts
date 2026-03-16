// Simple function — complexity 1 (no branching)
function add(a: number, b: number) { return a + b; }

// Medium — complexity 5
function classify(score: number): string {
  if (score > 90) return 'A';
  else if (score > 80) return 'B';
  else if (score > 70) return 'C';
  else if (score > 60) return 'D';
  return 'F';
}

// High — complexity 10+
function processOrder(order: Order) {
  if (!order) throw new InvalidOrderError('missing');
  if (!order.items) throw new InvalidOrderError('no items');
  for (const item of order.items) {
    if (item.quantity <= 0) continue;
    switch (item.type) {
      case 'physical': if (item.weight > 50) { /* ... */ } break;
      case 'digital': if (item.license) { /* ... */ } break;
      case 'subscription': if (item.interval && item.price > 0) { /* ... */ } break;
    }
  }
  if (order.coupon || order.discount) { /* ... */ }
}
