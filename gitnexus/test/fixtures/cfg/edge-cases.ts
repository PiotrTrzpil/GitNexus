/**
 * Fixture: edge-cases.ts
 *
 * Covers: empty function, unreachable code, early returns / guard clauses, async/await.
 * Used by tests: 1.8, 1.9, 1.12, 1.13
 */

// ── Empty function ─────────────────────────────────────────────────────────

export function noop(): void {}

// ── Unreachable code after return ──────────────────────────────────────────

export function dead(): number {
  return 42;
  // The lines below are statically unreachable:
  console.log('never');
  const x = 1;
  return x;
}

// ── Early returns / guard clauses ─────────────────────────────────────────

declare function doWork(input: string): void;

export function processInput(input: string | null): void {
  if (!input) return;
  if (input.length === 0) return;
  doWork(input);
}

// ── Multiple guard clauses with logic ─────────────────────────────────────

export function validateUser(user: { name: string; age: number } | null): boolean {
  if (!user) return false;
  if (user.name.length === 0) return false;
  if (user.age < 18) return false;
  return true;
}

// ── Async / await (current behavior: no suspension edges) ─────────────────

export async function fetchData(url: string): Promise<unknown> {
  // NOTE: await is currently treated as a regular Statement by oxc CFG,
  // not a suspension point. This is a known limitation documented in the design.
  const response = await fetch(url);
  if (!(response as any).ok) throw new Error('HTTP error');
  return await (response as any).json();
}

// ── Async function with try/catch ──────────────────────────────────────────

export async function safeFetch(url: string): Promise<unknown> {
  try {
    const response = await fetch(url);
    return await (response as any).json();
  } catch (err) {
    console.error('fetch failed', err);
    return null;
  }
}

// ── Throw without catch (propagates) ──────────────────────────────────────

export function mustExist(value: string | undefined): string {
  if (!value) {
    throw new Error('value is required');
  }
  return value;
}
