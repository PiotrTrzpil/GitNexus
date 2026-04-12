# Logger Migration Guide

This doc shows how to migrate from `console.log/error/warn` to the structured logger.

## Quick Start

```ts
import { logger, dbLogger, mcpLogger } from '../util/logger.js';

// Basic usage
logger.info('Server started');
logger.error({ err }, 'Operation failed');

// With context
logger.info({ repo: 'MyApp', durationMs: 1234 }, 'Index complete');

// Subsystem loggers (pre-configured with context)
dbLogger.warn('Connection pool low');
mcpLogger.error({ err, tool: 'query' }, 'Tool execution failed');
```

## Migration Patterns

### Pattern 1: Simple console.error → logger.error

**Before:**
```ts
console.error('Failed to load graph:', err);
```

**After:**
```ts
import { logger } from '../util/logger.js';

logger.error({ err }, 'Failed to load graph');
```

### Pattern 2: Warning with context

**Before:**
```ts
console.warn(`⚠️ Database locked (attempt ${attempt}/${MAX_ATTEMPTS}), retrying...`);
```

**After:**
```ts
import { dbLogger } from '../util/logger.js';

dbLogger.warn({ attempt, maxAttempts: MAX_ATTEMPTS }, 'Database locked, retrying');
```

### Pattern 3: Conditional/verbose logging

**Before:**
```ts
if (verbose) {
  console.log(`Processing file: ${file}`);
}
```

**After:**
```ts
// Debug level is filtered by GITNEXUS_LOG_LEVEL
logger.debug({ file }, 'Processing file');
```

### Pattern 4: Error in catch block

**Before:**
```ts
} catch (err) {
  console.error('Query failed:', err);
  throw err;
}
```

**After:**
```ts
import { dbLogger } from '../util/logger.js';

} catch (err) {
  dbLogger.error({ err, query: queryText }, 'Query failed');
  throw err;
}
```

### Pattern 5: Child logger for a subsystem

**Before (scattered context):**
```ts
console.log(`[MCP] Tool ${tool} called`);
console.error(`[MCP] Tool ${tool} failed:`, err);
```

**After (child logger):**
```ts
import { mcpLogger } from '../util/logger.js';

// Or create your own child
const toolLog = mcpLogger.child({ tool: 'query' });
toolLog.info('Tool called');
toolLog.error({ err }, 'Tool failed');
```

## Priority Migration Targets

1. **`core/lbug/lbug-adapter.ts`** - DB errors, lock retries
2. **`core/ingestion/workers/parse-worker.ts`** - Parse failures
3. **`mcp/local/local-backend.ts`** - Tool execution errors
4. **`core/ingestion/pipeline.ts`** - Ingestion progress/errors
5. **`mcp/server.ts`** - MCP protocol errors

## Environment Variables

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `GITNEXUS_LOG_LEVEL` | trace, debug, info, warn, error, fatal | info | Minimum level to log |
| `GITNEXUS_LOG_PRETTY` | 1 | (off) | Pretty-print to stderr (dev mode) |

## Log Location

Logs are written to `~/.gitnexus/logs/gitnexus.log`

- Rotates at 5MB
- Keeps 3 rotated files (gitnexus.log.1, .2, .3)
- JSON lines format (one JSON object per line)

## Viewing Logs

```bash
# Tail with pretty formatting
tail -f ~/.gitnexus/logs/gitnexus.log | pino-pretty

# Filter errors only
cat ~/.gitnexus/logs/gitnexus.log | jq 'select(.level >= 50)'

# Filter by context
cat ~/.gitnexus/logs/gitnexus.log | jq 'select(.context == "db")'
```
