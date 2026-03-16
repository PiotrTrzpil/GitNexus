/**
 * Fixture: nested-functions.ts
 *
 * Covers: top-level function, class methods, arrow functions, named inner functions.
 * Used by tests: 1.6, 1.7, 2.2, 4.1
 */

// ── Top-level function with nested arrow + named inner ─────────────────────

export function outer(): number {
  const inner = () => {
    return 1;
  };

  function named(): number {
    return 2;
  }

  return inner() + named();
}

// ── Class with multiple methods ────────────────────────────────────────────

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  divide(a: number, b: number): number {
    if (b === 0) throw new Error('div by zero');
    return a / b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }
}

// ── Class with constructor and private method ──────────────────────────────

export class UserService {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(): string {
    return `Hello, ${this.name}!`;
  }

  private validate(): boolean {
    return this.name.length > 0;
  }
}

// ── Arrow function at module level ─────────────────────────────────────────

export const transform = (value: string): string => {
  return value.trim().toLowerCase();
};

// ── Higher-order function returning an arrow ───────────────────────────────

export function makeAdder(base: number) {
  return (n: number) => base + n;
}
