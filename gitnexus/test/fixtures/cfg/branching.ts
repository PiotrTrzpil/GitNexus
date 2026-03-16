/**
 * Fixture: branching.ts
 *
 * Covers: if/else, switch, ternary, loops (for/while/do-while), try/catch/finally.
 * Used by tests: 1.2–1.5, 1.10, 4.1
 */

// ── If / else ──────────────────────────────────────────────────────────────

export function check(x: number): string {
  if (x > 0) {
    return 'positive';
  } else {
    return 'non-positive';
  }
}

// ── Switch ─────────────────────────────────────────────────────────────────

export function route(action: string): unknown {
  switch (action) {
    case 'create':
      return create();
    case 'update':
      return update();
    case 'delete':
      return deleteThing();
    default:
      throw new Error('unknown action');
  }
}

function create() { return 'created'; }
function update() { return 'updated'; }
function deleteThing() { return 'deleted'; }

// ── Ternary ────────────────────────────────────────────────────────────────

export function pick(flag: boolean): string {
  const result = flag ? computeA() : computeB();
  return result;
}

function computeA() { return 'A'; }
function computeB() { return 'B'; }

// ── Loops: for, while, do-while ────────────────────────────────────────────

declare function process(i: number): void;
declare function done(): boolean;
declare function step(): void;
declare function hasMore(): boolean;

export function loopy(): void {
  for (let i = 0; i < 10; i++) {
    process(i);
  }

  while (true) {
    if (done()) break;
  }

  do {
    step();
  } while (hasMore());
}

// ── Try / catch / finally ──────────────────────────────────────────────────

declare function dangerousOp(): void;
declare function handleError(e: unknown): void;
declare function cleanup(): void;

export function risky(): void {
  try {
    dangerousOp();
  } catch (e) {
    handleError(e);
  } finally {
    cleanup();
  }
}
