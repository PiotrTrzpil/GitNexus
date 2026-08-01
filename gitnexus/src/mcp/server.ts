/**
 * MCP Server (Multi-Repo)
 *
 * Model Context Protocol server that runs on stdio.
 * External AI tools (Cursor, Claude) spawn this process and
 * communicate via stdin/stdout using the MCP protocol.
 *
 * Supports multiple indexed repositories via the global registry.
 *
 * Tools: list_repos, query, cypher, context, impact, detect_changes, rename
 * Resources: repos, repo/{name}/context, repo/{name}/clusters, ...
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CompatibleStdioServerTransport } from './compatible-stdio-transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import os from 'os';
import path from 'path';
import { GITNEXUS_TOOLS } from './tools.js';
import type { LocalBackend } from './local/local-backend.js';
import { getResourceDefinitions, getResourceTemplates, readResource } from './resources.js';
import { startWatcher } from '../core/watcher/file-watcher.js';
import { tryAcquireLock, releaseLock, getLockInfo, refreshLock } from '../util/lockfile.js';
import {
  armSigkillWatchdog,
  DEFAULT_FORCE_EXIT_MS,
  exitWithWatchdog,
} from '../util/process-lifecycle.js';
import { mcpLogger } from '../util/logger.js';
import { VERSION } from '../config/version.js';

/**
 * Path to the global watcher-leader lockfile.
 *
 * Only one MCP server per machine runs the file watcher. With multiple
 * concurrent Claude Code sessions, each spawns its own MCP — without this
 * lock, every MCP would walk every indexed repo's filesystem on its own
 * polling cadence, multiplying FS load N-fold and producing the racing-
 * reindex pattern observed in logs.
 */
const WATCHER_LEADER_LOCK = path.join(os.homedir(), '.gitnexus', 'watcher.leader.lock');

/**
 * How often a follower MCP retries acquiring the watcher-leader lock.
 * Short enough that a follower takes over quickly when the leader exits;
 * long enough that idle followers stay quiet.
 */
const FOLLOWER_RETRY_MS = 15_000;

/**
 * Leader heartbeat interval. The previous lock implementation treated any lock
 * older than 5 minutes as stale *even if the leader PID was still alive*, so
 * after 5 minutes every follower stole the lock and started its own watcher —
 * 12 concurrent reindexers on one repo, DB files deleted under open handles,
 * SIGSEGV. stealFromLive:false stops that; the heartbeat keeps diagnostics accurate.
 */
const LEADER_HEARTBEAT_MS = 60_000;


/**
 * Next-step hints appended to tool responses.
 *
 * Agents often stop after one tool call. These hints guide them to the
 * logical next action, creating a self-guiding workflow without hooks.
 *
 * Design: Each hint is a short, actionable instruction (not a suggestion).
 * The hint references the specific tool/resource to use next.
 */
function getNextStepHint(toolName: string, args: Record<string, any> | undefined): string {
  const repo = args?.repo;
  const repoParam = repo ? `, repo: "${repo}"` : '';
  const repoPath = repo || '{name}';

  switch (toolName) {
    case 'list_repos':
      return `\n\n---\n**Next:** READ gitnexus://repo/{name}/context for any repo above to get its overview and check staleness.`;

    case 'query':
      return `\n\n---\n**Next:** To understand a specific symbol in depth, use context({name: "<symbol_name>"${repoParam}}) to see categorized refs and process participation.`;

    case 'context':
      return `\n\n---\n**Next:** If planning changes, use impact({target: "${args?.name || '<name>'}", direction: "upstream"${repoParam}}) to check blast radius. To see execution flows, READ gitnexus://repo/${repoPath}/processes.`;

    case 'impact':
      return `\n\n---\n**Next:** Review d=1 items first (WILL BREAK). To check affected execution flows, READ gitnexus://repo/${repoPath}/processes.`;

    case 'detect_changes':
      return `\n\n---\n**Next:** Review affected processes. Use context() on high-risk changed symbols. READ gitnexus://repo/${repoPath}/process/{name} for full execution traces.`;

    case 'rename':
      return `\n\n---\n**Next:** Run detect_changes(${repoParam ? `{repo: "${repo}"}` : ''}) to verify no unexpected side effects from the rename.`;

    case 'cypher':
      return `\n\n---\n**Next:** To explore a result symbol, use context({name: "<name>"${repoParam}}). For schema reference, READ gitnexus://repo/${repoPath}/schema.`;

    // Legacy tool names — still return useful hints
    case 'search':
      return `\n\n---\n**Next:** To understand a result in context, use context({name: "<symbol_name>"${repoParam}}).`;
    case 'explore':
      return `\n\n---\n**Next:** If planning changes, use impact({target: "<name>", direction: "upstream"${repoParam}}).`;
    case 'overview':
      return `\n\n---\n**Next:** To drill into an area, READ gitnexus://repo/${repoPath}/cluster/{name}. To see execution flows, READ gitnexus://repo/${repoPath}/processes.`;

    default:
      return '';
  }
}

/**
 * Create a configured MCP Server with all handlers registered.
 * Transport-agnostic — caller connects the desired transport.
 */
/**
 * Fetch client workspace roots and pass them to the backend for repo auto-detection.
 * Silently no-ops if the client doesn't support roots.
 */
async function syncClientRoots(server: Server, backend: LocalBackend): Promise<void> {
  try {
    const { roots } = await server.listRoots();
    backend.setClientRoots(roots.map((r) => r.uri));
  } catch {
    // Client doesn't support roots — that's fine, fall back to process.cwd()
  }
}

export function createMCPServer(backend: LocalBackend): Server {
  const server = new Server(
    {
      name: 'gitnexus',
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // Sync client workspace roots for repo auto-detection.
  // oninitialized fires after the client handshake completes — listRoots() is safe to call.
  server.oninitialized = () => { syncClientRoots(server, backend); };

  // Re-sync when the client reports changed roots (e.g. user switched project)
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    await syncClientRoots(server, backend);
  });

  // Handle list resources request
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = getResourceDefinitions();
    return {
      resources: resources.map(r => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    };
  });

  // Handle list resource templates request (for dynamic resources)
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const templates = getResourceTemplates();
    return {
      resourceTemplates: templates.map(t => ({
        uriTemplate: t.uriTemplate,
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
      })),
    };
  });

  // Handle read resource request
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    try {
      const content = await readResource(uri, backend);
      return {
        contents: [
          {
            uri,
            mimeType: 'text/yaml',
            text: content,
          },
        ],
      };
    } catch (err: any) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `Error: ${err.message}`,
          },
        ],
      };
    }
  });


  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: GITNEXUS_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  // Handle tool calls — append next-step hints to guide agent workflow
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await backend.callTool(name, args);
      const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      // Don't append next-step hints when the tool returned an error object —
      // hints like "Review d=1 items (WILL BREAK)" are misleading after a
      // "Target not found" error and confuse agents into skipping analysis.
      const isErrorResult = result != null && typeof result === 'object' && !Array.isArray(result) && 'error' in result;
      const hint = isErrorResult ? '' : getNextStepHint(name, args as Record<string, any> | undefined);

      return {
        content: [
          {
            type: 'text',
            text: resultText + hint,
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Handle list prompts request
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'detect_impact',
        description: 'Analyze the impact of your current changes before committing. Guides through scope selection, change detection, process analysis, and risk assessment.',
        arguments: [
          { name: 'scope', description: 'What to analyze: unstaged, staged, all, or compare', required: false },
          { name: 'base_ref', description: 'Branch/commit for compare scope', required: false },
        ],
      },
      {
        name: 'generate_map',
        description: 'Generate architecture documentation from the knowledge graph. Creates a codebase overview with execution flows and mermaid diagrams.',
        arguments: [
          { name: 'repo', description: 'Repository name (omit if only one indexed)', required: false },
        ],
      },
    ],
  }));

  // Handle get prompt request
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'detect_impact') {
      const scope = args?.scope || 'all';
      const baseRef = args?.base_ref || '';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Analyze the impact of my current code changes before committing.

Follow these steps:
1. Run \`detect_changes(${JSON.stringify({ scope, ...(baseRef ? { base_ref: baseRef } : {}) })})\` to find what changed and affected processes
2. For each changed symbol in critical processes, run \`context({name: "<symbol>"})\` to see its full reference graph
3. For any high-risk items (many callers or cross-process), run \`impact({target: "<symbol>", direction: "upstream"})\` for blast radius
4. Summarize: changes, affected processes, risk level, and recommended actions

Present the analysis as a clear risk report.`,
            },
          },
        ],
      };
    }

    if (name === 'generate_map') {
      const repo = args?.repo || '';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Generate architecture documentation for this codebase using the knowledge graph.

Follow these steps:
1. READ \`gitnexus://repo/${repo || '{name}'}/context\` for codebase stats
2. READ \`gitnexus://repo/${repo || '{name}'}/clusters\` to see all functional areas
3. READ \`gitnexus://repo/${repo || '{name}'}/processes\` to see all execution flows
4. For the top 5 most important processes, READ \`gitnexus://repo/${repo || '{name}'}/process/{name}\` for step-by-step traces
5. Generate a mermaid architecture diagram showing the major areas and their connections
6. Write an ARCHITECTURE.md file with: overview, functional areas, key execution flows, and the mermaid diagram`,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  return server;
}

/**
 * Start the MCP server on stdio transport (for CLI use).
 */
export async function startMCPServer(backend: LocalBackend): Promise<void> {
  const server = createMCPServer(backend);

  // Connect to stdio transport
  const transport = new CompatibleStdioServerTransport();
  await server.connect(transport);

  // ── File watcher (leader-only) ────────────────────────────────────
  // Start adaptive polling loop after backend is initialized.
  // onReindex triggers a pipeline re-run for the changed repo.
  //
  // Leader election: only one MCP per machine actually polls. Followers
  // periodically retry the lock so they take over if the leader exits or
  // dies. The lockfile uses PID-based stale detection, so a SIGKILLed
  // leader is reclaimed automatically on the next follower retry.
  let stopWatcher: (() => void) | undefined;
  let leaderRetryTimer: NodeJS.Timeout | undefined;
  let leaderHeartbeatTimer: NodeJS.Timeout | undefined;
  let isLeader = false;

  const stopLeaderHeartbeat = () => {
    if (leaderHeartbeatTimer) {
      clearInterval(leaderHeartbeatTimer);
      leaderHeartbeatTimer = undefined;
    }
  };

  const startLeaderHeartbeat = () => {
    stopLeaderHeartbeat();
    leaderHeartbeatTimer = setInterval(() => {
      void refreshLock(WATCHER_LEADER_LOCK).then((ok) => {
        if (!ok) {
          // Another process took leadership (shouldn't happen with stealFromLive:false
          // unless we were SIGKILL'd mid-refresh). Stop watching to avoid dual leaders.
          mcpLogger.warn({ pid: process.pid }, 'Lost watcher leader lock — stopping watcher');
          try { stopWatcher?.(); } catch {}
          stopWatcher = undefined;
          isLeader = false;
          stopLeaderHeartbeat();
        }
      });
    }, LEADER_HEARTBEAT_MS);
    leaderHeartbeatTimer.unref();
  };

  const tryStartWatcher = async (): Promise<boolean> => {
    if (isLeader) return true;
    // Only reclaim if the previous leader PID is dead — never steal from a live leader
    // just because the lock timestamp aged past 5 minutes (that caused multi-watcher storms).
    if (!(await tryAcquireLock(WATCHER_LEADER_LOCK, { stealFromLive: false }))) return false;
    try {
      const repos = await backend.getWatchableRepos();
      if (repos.length === 0) {
        await releaseLock(WATCHER_LEADER_LOCK);
        return false;
      }
      stopWatcher = startWatcher(repos, {
        onReindex: (repoPath: string) => backend.reindexRepo(repoPath),
      });
      isLeader = true;
      startLeaderHeartbeat();
      mcpLogger.info({ pid: process.pid, lockPath: WATCHER_LEADER_LOCK }, 'Watcher leader acquired');
      return true;
    } catch (err) {
      // If watcher setup fails, drop the lock so another MCP can try.
      stopLeaderHeartbeat();
      await releaseLock(WATCHER_LEADER_LOCK);
      mcpLogger.warn({ err }, 'Watcher start failed after lock acquired — releasing');
      return false;
    }
  };

  if (!(await tryStartWatcher())) {
    const info = await getLockInfo(WATCHER_LEADER_LOCK);
    mcpLogger.info(
      { leaderPid: info?.pid, retryMs: FOLLOWER_RETRY_MS },
      'Watcher leader already running — this MCP will run as follower'
    );
    leaderRetryTimer = setInterval(() => {
      tryStartWatcher().catch(() => { /* keep retrying */ });
    }, FOLLOWER_RETRY_MS);
    leaderRetryTimer.unref();
  }

  // Graceful shutdown helper.
  //
  // The LadybugDB native binding (lbugjs.node) has a destructor bug:
  // `MaterializedQueryResult::~MaterializedQueryResult()` can recurse and never
  // return. If a leaked QueryResult is finalized during disconnect, the main
  // thread wedges and `process.exit(0)` is never reached — leaving a zombie
  // process whose file watcher keeps polling and racing with the next session's
  // MCP.
  //
  // Soft exit always goes through exitWithWatchdog / armSigkillWatchdog so a
  // wedged main thread is SIGKILL'd by an independent Worker (see
  // util/process-lifecycle.ts). Fatal signals (SIGSEGV, …) are handled in
  // cli/mcp.ts with immediate hardKillSelf — never process.exit.
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Arm first — cleanup below may never return.
    armSigkillWatchdog(DEFAULT_FORCE_EXIT_MS);

    try { if (leaderRetryTimer) clearInterval(leaderRetryTimer); } catch {}
    try { stopLeaderHeartbeat(); } catch {}
    try { if (ppidPoll) clearInterval(ppidPoll); } catch {}
    try { stopWatcher?.(); } catch {}
    if (isLeader) {
      try { await releaseLock(WATCHER_LEADER_LOCK); } catch {}
    }
    try { await backend.disconnect(); } catch {}
    try { await server.close(); } catch {}

    exitWithWatchdog(0, DEFAULT_FORCE_EXIT_MS);
  };

  // Handle graceful shutdown (fatal signals are installed in cli/mcp.ts)
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGHUP', () => { void shutdown(); });

  // Handle stdio errors — stdin close means the parent process is gone
  process.stdin.on('end', () => { void shutdown(); });
  process.stdin.on('error', () => { void shutdown(); });
  process.stdout.on('error', () => { void shutdown(); });

  // Proactive orphan detection. macOS has no PR_SET_PDEATHSIG equivalent and
  // some MCP-client crashes don't cleanly close stdin, so the `stdin.on('end')`
  // hook above is not sufficient. Polling `process.ppid` catches both
  // orphan-on-startup (PPID already 1) and mid-life reparenting to launchd.
  let ppidPoll: NodeJS.Timeout | undefined;
  const checkOrphaned = () => {
    if (process.ppid === 1) {
      mcpLogger.info({ pid: process.pid }, 'Parent process gone (PPID=1) — shutting down');
      void shutdown();
    }
  };
  checkOrphaned();
  ppidPoll = setInterval(checkOrphaned, 5_000);
  ppidPoll.unref();
}
