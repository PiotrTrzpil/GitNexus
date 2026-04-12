/**
 * MCP Command
 * 
 * Starts the MCP server in standalone mode.
 * Loads all indexed repos from the global registry.
 * No longer depends on cwd — works from any directory.
 */

import { startMCPServer } from '../mcp/server.js';
import { LocalBackend } from '../mcp/local/local-backend.js';

export const mcpCommand = async () => {
  // Import logger for crash diagnostics
  const { mcpLogger } = await import('../util/logger.js');

  // Log startup
  mcpLogger.info('MCP server starting');

  // Prevent unhandled errors from crashing the MCP server process.
  // LadybugDB lock conflicts and transient errors should degrade gracefully.
  process.on('uncaughtException', (err) => {
    mcpLogger.fatal({ err }, 'Uncaught exception — exiting');
    console.error(`GitNexus MCP: uncaught exception — ${err.message}\n${err.stack}`);
    // Process is in an undefined state after uncaughtException — exit after flushing
    setTimeout(() => process.exit(1), 100);
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    mcpLogger.error({ err }, 'Unhandled rejection');
    console.error(`GitNexus MCP: unhandled rejection — ${err.message}`);
  });

  // Log ALL signals for crash tracking
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGFPE'];
  for (const sig of signals) {
    process.on(sig, () => {
      // Sync write to stderr - logger may not flush
      try { require('fs').writeSync(2, `\n[MCP CRASH] Received ${sig}\n`); } catch {}
      mcpLogger.fatal(`Received ${sig}, shutting down`);
      mcpLogger.flush();
      process.exit(128 + (signals.indexOf(sig) + 1));
    });
  }

  // Log process exit
  process.on('exit', (code) => {
    try { require('fs').writeSync(2, `[MCP] Process exiting with code ${code}\n`); } catch {}
  });

  // Initialize multi-repo backend from registry.
  // The server starts even with 0 repos — tools call refreshRepos() lazily,
  // so repos indexed after the server starts are discovered automatically.
  const backend = new LocalBackend();
  await backend.init();

  const repos = await backend.listRepos();
  if (repos.length === 0) {
    console.error('GitNexus: No indexed repos yet. Run `gitnexus analyze` in a git repo — the server will pick it up automatically.');
  } else {
    console.error(`GitNexus: MCP server starting with ${repos.length} repo(s): ${repos.map(r => r.name).join(', ')}`);
  }

  // Start MCP server (serves all repos, discovers new ones lazily)
  await startMCPServer(backend);
};
