/**
 * Status Command
 * 
 * Shows the indexing status of the current repository.
 */

import { findRepo, getStoragePaths, hasKuzuIndex } from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo, getGitRoot, getWorkingTreeStatus } from '../storage/git.js';

export const statusCommand = async () => {
  const cwd = process.cwd();

  if (!isGitRepo(cwd)) {
    console.log('Not a git repository.');
    return;
  }

  const repo = await findRepo(cwd);
  if (!repo) {
    // Check if there's a stale KuzuDB index that needs migration
    const repoRoot = getGitRoot(cwd) ?? cwd;
    const { storagePath } = getStoragePaths(repoRoot);
    if (await hasKuzuIndex(storagePath)) {
      console.log('Repository has a stale KuzuDB index from a previous version.');
      console.log('Run: gitnexus analyze   (rebuilds the index with LadybugDB)');
    } else {
      console.log('Repository not indexed.');
      console.log('Run: gitnexus analyze');
    }
    return;
  }

  const currentCommit = getCurrentCommit(repo.repoPath);
  const commitMatches = currentCommit === repo.meta.lastCommit;
  const wt = getWorkingTreeStatus(repo.repoPath);
  const dirty = wt.changed.length > 0 || wt.untracked.length > 0;

  console.log(`Repository: ${repo.repoPath}`);
  console.log(`Indexed: ${new Date(repo.meta.indexedAt).toLocaleString()}`);
  console.log(`Indexed commit: ${repo.meta.lastCommit?.slice(0, 7)}`);
  console.log(`Current commit: ${currentCommit?.slice(0, 7)}`);
  if (dirty) {
    console.log(`Working tree: ${wt.changed.length} changed, ${wt.untracked.length} untracked`);
  }

  let statusLine: string;
  if (!commitMatches) {
    statusLine = '⚠️ stale (re-run gitnexus analyze)';
  } else if (dirty) {
    statusLine = '⚠️ stale: uncommitted edits since last index (re-run gitnexus analyze)';
  } else {
    statusLine = '✅ up-to-date';
  }
  console.log(`Status: ${statusLine}`);
};
