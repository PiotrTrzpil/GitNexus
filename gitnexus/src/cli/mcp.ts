/**
 * MCP Command
 *
 * Starts the MCP server in standalone mode.
 * Loads all indexed repos from the global registry.
 * No longer depends on cwd — works from any directory.
 */

import { startMCPServer } from '../mcp/server.js';
import { LocalBackend } from '../mcp/local/local-backend.js';
import {
  exitWithWatchdog,
  installFatalSignalHandlers,
} from '../util/process-lifecycle.js';

export const mcpCommand = async () => {
  // Import logger for crash diagnostics
  const { mcpLogger } = await import('../util/logger.js');

  // Log startup
  mcpLogger.info('MCP server starting');

  // Prevent unhandled errors from crashing the MCP server process into an
  // undefined state without a kill deadline. LadybugDB lock conflicts should
  // ideally be caught closer to the call site; if they escape, we still must
  // not hang forever inside process.exit / threadpool join.
  process.on('uncaughtException', (err) => {
    mcpLogger.fatal({ err }, 'Uncaught exception — exiting');
    console.error(`GitNexus MCP: uncaught exception — ${err.message}\n${err.stack}`);
    // Process is in an undefined state after uncaughtException — exit with a
    // hard deadline so a stuck native destructor cannot orphan us.
    exitWithWatchdog(1, 1000);
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    mcpLogger.error({ err }, 'Unhandled rejection');
    console.error(`GitNexus MCP: unhandled rejection — ${err.message}`);
  });

  // Fatal hardware / abort signals: NEVER call process.exit().
  // Observed in production (pid 23822, 2026-07-22): SIGSEGV handler logged
  // "shutting down", then process.exit hung in uv_thread_join while a
  // DatabaseInit worker spun in LadybugDB RelTable construction — 100% CPU
  // for 4.7 days under launchd (PPID=1).
  // Graceful signals (SIGINT/SIGTERM/SIGHUP) are owned by startMCPServer,
  // which arms the same SIGKILL watchdog after cleanup.
  installFatalSignalHandlers((sig) => {
    try {
      mcpLogger.fatal(`Received ${sig}, force-killing`);
      mcpLogger.flush();
    } catch {
      // Logger may be unusable after a segfault.
    }
  });

  // Log process exit
  process.on('exit', (code) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('fs').writeSync(2, `[MCP] Process exiting with code ${code}\n`);
    } catch {}
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
