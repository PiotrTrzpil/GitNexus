// Stub — KuzuDB adapter is not yet implemented.
// This file exists to satisfy the dynamic import in local-backend.ts.

import type { KnowledgeGraph } from '../graph/types.js';

export async function loadGraphToKuzu(
  _graph: KnowledgeGraph,
  _repoPath: string,
  _storagePath: string,
): Promise<void> {
  throw new Error('KuzuDB adapter is not yet implemented');
}

export async function closeKuzu(_id: string): Promise<void> {
  // no-op
}
