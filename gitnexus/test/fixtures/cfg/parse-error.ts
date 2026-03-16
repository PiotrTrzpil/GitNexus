/**
 * Fixture: parse-error.ts
 *
 * Contains a valid function, an intentionally broken function (syntax error),
 * and another valid function. Tests that analyzeCfg returns partial results
 * and populates the errors array.
 *
 * Used by test: 1.15
 *
 * NOTE: This file intentionally contains a syntax error. It will NOT compile
 * with tsc and should NOT be included in tsconfig paths. The test passes it
 * as a raw string to analyzeCfg(), which is expected to handle parse errors
 * gracefully and return partial results.
 */

// This file is read as a string by the test — it is NOT imported.
// The syntax error is on the `broken` function definition.
//
// Source used in test 1.15:
//
//   function valid() { return 1; }
//   function broken( { return; }      <-- missing closing paren — syntax error
//   function alsoValid() { return 2; }
