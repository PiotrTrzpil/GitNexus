#!/usr/bin/env node
/**
 * Postinstall script for @gitnexus/oxc-cfg native binding.
 *
 * Execution order:
 *   1. Check if a prebuilt .node binary already exists in the native dir — skip if so.
 *   2. Check if `cargo` is in PATH.
 *      a. If yes: run `cargo build --release` and copy the output .node file.
 *      b. If no: print a warning and exit 0 (graceful degradation — GitNexus
 *         will run without CFG analysis; all other features remain intact).
 *
 * This mirrors the tree-sitter-swift postinstall pattern used elsewhere in
 * this package: fail gracefully so that `npm install` never hard-fails on
 * machines without a Rust toolchain.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ── Paths ─────────────────────────────────────────────────────────────────────

const nativeDir = path.join(__dirname, '..', 'native', 'oxc-cfg-napi');

/**
 * Return the platform-specific filename that napi-rs uses for the compiled
 * .node addon, e.g. "oxc-cfg.darwin-arm64.node".
 */
function getExpectedBinaryName() {
  const platform = process.platform; // 'darwin', 'linux', 'win32'
  const arch = process.arch;         // 'x64', 'arm64'

  const platformMap = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'win32',
  };
  const archMap = {
    x64: 'x64',
    arm64: 'arm64',
  };

  const p = platformMap[platform] ?? platform;
  const a = archMap[arch] ?? arch;

  // napi-rs convention: <name>.<platform>-<arch>.node
  // On linux with glibc the suffix includes "-gnu"; on Windows "-msvc".
  let suffix = `${p}-${a}`;
  if (platform === 'linux') suffix += '-gnu';
  if (platform === 'win32') suffix += '-msvc';

  return `oxc-cfg.${suffix}.node`;
}

/**
 * napi-rs also produces a plain "index.node" (or "oxc-cfg.node") in some
 * configurations. Accept either name.
 */
function findExistingBinary() {
  const candidates = [
    getExpectedBinaryName(),
    'oxc-cfg.node',
    'index.node',
  ];
  for (const name of candidates) {
    const full = path.join(nativeDir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

// ── Cargo output path ─────────────────────────────────────────────────────────

/**
 * Return the path where `cargo build --release` places the .node file.
 * napi-rs puts it at target/release/<crate_name>.node (or .dylib/.dll which
 * it then renames to .node).
 */
function getCargoOutputPath() {
  const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
  // Try .node first (napi-rs may produce it directly with the right cdylib name)
  const base = path.join(nativeDir, 'target', 'release');
  // napi-rs names the cdylib after the package `name` in Cargo.toml: "oxc_cfg_napi"
  const candidates = [
    path.join(base, 'oxc_cfg_napi.node'),
    path.join(base, `liboxc_cfg_napi.${ext}`),
    path.join(base, `oxc_cfg_napi.${ext}`),
  ];
  return candidates;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cargoInPath() {
  const result = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

function copyBinaryToNativeDir(src) {
  const dest = path.join(nativeDir, getExpectedBinaryName());
  fs.copyFileSync(src, dest);
  console.log(`[oxc-cfg] Binary copied to ${dest}`);
  return dest;
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  // 1. Check for an already-present prebuilt binary.
  const existing = findExistingBinary();
  if (existing) {
    console.log(`[oxc-cfg] Prebuilt binary found at ${existing} — skipping build`);
    process.exit(0);
  }

  // 2. No prebuilt binary. Check for cargo.
  if (!cargoInPath()) {
    console.warn(
      '[oxc-cfg] No prebuilt binary and `cargo` not found in PATH — CFG analysis disabled.\n' +
      '[oxc-cfg] Install a Rust toolchain (https://rustup.rs) or use a prebuilt binary to enable CFG analysis.',
    );
    process.exit(0);
  }

  // 3. Run cargo build --release.
  console.log('[oxc-cfg] Building native binding (cargo build --release)...');
  console.log('[oxc-cfg] This may take a few minutes on first build.');

  execSync('cargo build --release', {
    cwd: nativeDir,
    stdio: 'inherit',
    timeout: 600_000, // 10 minutes — Rust compile can be slow
  });

  // 4. Locate the compiled artifact and copy to nativeDir.
  const candidates = getCargoOutputPath();
  const built = candidates.find(p => fs.existsSync(p));

  if (!built) {
    throw new Error(
      `cargo build succeeded but could not locate output binary.\n` +
      `Searched:\n${candidates.map(p => `  ${p}`).join('\n')}`,
    );
  }

  copyBinaryToNativeDir(built);
  console.log('[oxc-cfg] Native binding built successfully');
} catch (err) {
  console.warn('[oxc-cfg] Could not build native binding:', err.message);
  console.warn('[oxc-cfg] CFG analysis will be disabled. GitNexus will continue without it.');
  // Exit 0 — graceful degradation, do not fail `npm install`.
  process.exit(0);
}
