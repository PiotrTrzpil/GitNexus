/**
 * Fixture: plain.js
 *
 * JavaScript without TypeScript type annotations.
 * Used by test: 1.14
 */

// ── Simple arithmetic ──────────────────────────────────────────────────────

function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

// ── Conditional logic ──────────────────────────────────────────────────────

function classify(n) {
  if (n > 0) {
    return 'positive';
  } else if (n < 0) {
    return 'negative';
  } else {
    return 'zero';
  }
}

// ── Loop ───────────────────────────────────────────────────────────────────

function sumArray(arr) {
  let total = 0;
  for (let i = 0; i < arr.length; i++) {
    total += arr[i];
  }
  return total;
}

// ── Arrow function ─────────────────────────────────────────────────────────

const double = (x) => x * 2;

// ── CommonJS-style export (valid JS) ──────────────────────────────────────

module.exports = { add, subtract, classify, sumArray, double };
