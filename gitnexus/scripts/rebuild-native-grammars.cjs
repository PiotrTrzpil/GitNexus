#!/usr/bin/env node
/**
 * Rebuild native tree-sitter grammar bindings that lack prebuilts for the
 * current Node ABI.
 *
 * Problem: tree-sitter grammar packages that use node-gyp (not prebuildify)
 * may not have prebuilt .node binaries for the current Node ABI. When running
 * on a newer Node, `require()` throws "No native build was found for
 * platform=... abi=...".
 *
 * Fix: For each grammar, try to require() it. If it fails with the ABI
 * mismatch error, rebuild from source with node-gyp. This runs as part of
 * postinstall so the fix is permanent across installs.
 *
 * NOTE: Most grammar packages (tree-sitter-javascript, tree-sitter-python,
 * etc.) ship with prebuildify prebuilts since tree-sitter 0.22+ and do not
 * need this script. Only grammars that still use node-gyp are listed here.
 */
const path = require('path');
const { execSync } = require('child_process');

const GRAMMARS_TO_CHECK = [
  'tree-sitter-kotlin',
];

for (const pkg of GRAMMARS_TO_CHECK) {
  let pkgDir;
  try {
    // Resolve the package's directory (require.resolve gets the main entry,
    // we want the package root)
    const entry = require.resolve(pkg);
    pkgDir = entry;
    // Walk up to find package.json
    let dir = path.dirname(entry);
    while (dir !== path.dirname(dir)) {
      try {
        require(path.join(dir, 'package.json'));
        pkgDir = dir;
        break;
      } catch {
        dir = path.dirname(dir);
      }
    }
  } catch {
    // Package not installed (optional dep) — skip
    continue;
  }

  // Try loading — if it works, no rebuild needed
  try {
    require(pkg);
    continue;
  } catch (err) {
    if (!err.message.includes('No native build was found') &&
        !err.message.includes('Cannot find module') &&
        !err.message.includes('was compiled against a different Node.js version')) {
      // Some other error — skip, don't mask it
      continue;
    }
  }

  // Native binary missing or ABI mismatch — rebuild from source
  console.log(`[${pkg}] No prebuilt binary for Node ${process.version} (ABI ${process.versions.modules}). Rebuilding from source...`);
  try {
    execSync('npx node-gyp rebuild', {
      cwd: pkgDir,
      stdio: 'pipe',
      timeout: 120000,
    });
    // Verify it loads now
    delete require.cache[require.resolve(pkg)];
    require(pkg);
    console.log(`[${pkg}] Rebuilt successfully`);
  } catch (rebuildErr) {
    console.warn(`[${pkg}] Could not rebuild: ${rebuildErr.message}`);
    console.warn(`[${pkg}] Try manually: cd ${pkgDir} && npx node-gyp rebuild`);
  }
}
