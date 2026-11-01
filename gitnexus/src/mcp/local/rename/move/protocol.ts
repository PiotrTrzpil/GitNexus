/**
 * Message contract between the file/directory move planner and its ts-morph
 * worker thread. The worker only COMPUTES; it never writes to disk, so the hard
 * timeout (worker.terminate()) can never leave a half-applied move behind.
 */

export interface MoveRequest {
  type: 'plan-move';
  /** Absolute repository root. */
  repoPath: string;
  /** Absolute source / destination of the moved file or directory. */
  from: string;
  to: string;
  kind: 'file' | 'directory';
  /** Absolute paths of the TS/JS files that move (every file for kind=file). */
  tsFiles: string[];
}

export interface MoveEdit {
  /** Repo-relative path of the file after the move. */
  filePath: string;
  line: number;
  old_text: string;
  new_text: string;
  confidence: 'ts_morph';
}

export interface MoveWrite {
  /** Absolute path to write (a moved file's new location, or an importer in place). */
  path: string;
  text: string;
}

export interface MoveSuccess {
  type: 'success';
  edits: MoveEdit[];
  writes: MoveWrite[];
}

export interface MoveError {
  type: 'error';
  message: string;
}

export type MoveResponse = MoveSuccess | MoveError;
