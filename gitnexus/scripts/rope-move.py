"""
Rope-powered module/package move for Python files.

Communicates via stdin/stdout JSON. Designed to be invoked from Node.js
via child_process.

Moves a Python module (.py file) or package (directory) to a new path and
rewrites import statements across the project using rope's MoveModule /
Rename refactorings.

Safety:
  dryRun=true NEVER mutates the real repository. Refactorings run on an
  isolated temporary sandbox (copied .py tree). Kill/timeout cannot leave
  partial applies in the user's tree.

  dryRun=false applies to the real tree. Prefer reviewing a dry-run first.

Input (JSON on stdin):
  {
    "repoPath": str,
    "oldPath": str,          # repo-relative file or directory
    "newPath": str,          # repo-relative destination file or directory
    "dryRun": bool,
    "sourceFolders": [str]   # optional rope source roots, e.g. ["src"]
  }

Output (JSON on stdout):
  Success: {
    "status": "ok",
    "edits": [...],
    "files_moved": [{"from": str, "to": str}, ...]
  }
  Error: { "status": "error", "message": str }

Exit codes:
  0 — success
  1 — error (message in JSON output)
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from typing import Any


# Directories skipped when building sandboxes / walking trees (speed + noise)
IGNORE_DIR_NAMES = {
    ".git",
    ".gitnexus",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    ".env",
    "node_modules",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".nox",
    ".eggs",
    "dist",
    "build",
    "target",
    "coverage",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    "site-packages",
    ".ropeproject",
}

PY_SUFFIXES = (".py", ".pyw", ".pyi")


def compute_edits(source_before: str, source_after: str, file_path: str) -> list[dict]:
    """Diff two file contents and return per-line edits."""
    old_lines = source_before.split("\n")
    new_lines = source_after.split("\n")
    edits: list[dict] = []
    max_len = max(len(old_lines), len(new_lines))
    for i in range(max_len):
        old = old_lines[i] if i < len(old_lines) else ""
        new = new_lines[i] if i < len(new_lines) else ""
        if old != new:
            edits.append(
                {
                    "filePath": file_path,
                    "line": i + 1,
                    "old_text": old.strip(),
                    "new_text": new.strip(),
                    "confidence": "rope",
                }
            )
    return edits


def should_ignore_dir(name: str) -> bool:
    return name in IGNORE_DIR_NAMES or (name.startswith(".") and name not in (".", ".."))


def iter_python_files(root: str) -> list[str]:
    """Repo-relative paths of Python sources under root."""
    result: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not should_ignore_dir(d)]
        if ".ropeproject" in dirpath.split(os.sep):
            continue
        for name in filenames:
            if name.endswith(PY_SUFFIXES):
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                result.append(rel)
    return result


def snapshot_python_tree(root: str) -> dict[str, str]:
    """Read Python file contents as {rel_path: content}."""
    result: dict[str, str] = {}
    for rel in iter_python_files(root):
        full = os.path.join(root, rel)
        try:
            with open(full, "r", encoding="utf-8") as fh:
                result[rel] = fh.read()
        except (UnicodeDecodeError, OSError):
            result[rel] = ""
    return result


def list_all_files(root: str) -> set[str]:
    """All regular files under root (respecting ignore dirs), repo-relative."""
    result: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not should_ignore_dir(d)]
        if ".ropeproject" in dirpath.split(os.sep):
            continue
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            result.add(rel)
    return result


def infer_source_folders(repo_path: str, old_path: str) -> list[str]:
    """
    Infer rope source_folders from common layouts so imports like
    `from utils.helpers import x` resolve when code lives under src/.
    """
    candidates: list[str] = []
    for name in ("src", "lib", "app"):
        if os.path.isdir(os.path.join(repo_path, name)):
            candidates.append(name)
    parts = old_path.replace("\\", "/").split("/")
    if parts and parts[0] and parts[0] not in candidates:
        first = os.path.join(repo_path, parts[0])
        if os.path.isdir(first) and parts[0] not in (".", ".."):
            for dirpath, dirnames, filenames in os.walk(first):
                dirnames[:] = [d for d in dirnames if not should_ignore_dir(d)]
                if any(f.endswith(PY_SUFFIXES) for f in filenames):
                    candidates.append(parts[0])
                    break
    return candidates


def ensure_folder(project: Any, rel_folder: str) -> Any:
    """Ensure a folder resource exists. Creates intermediate folders via rope."""
    rel_folder = rel_folder.replace("\\", "/").strip("/")
    if not rel_folder:
        return project.root

    current = project.root
    for part in rel_folder.split("/"):
        if not part or part in (".", ".."):
            continue
        try:
            child = current.get_child(part)
        except Exception:
            child = None
        if child is None:
            child = current.create_folder(part)
        current = child
    return current


def module_basename(path: str) -> str:
    path = path.replace("\\", "/").rstrip("/")
    base = os.path.basename(path)
    if base.endswith(PY_SUFFIXES):
        return os.path.splitext(base)[0]
    return base


def parent_rel(path: str) -> str:
    path = path.replace("\\", "/").rstrip("/")
    parent = os.path.dirname(path)
    return "" if parent in (".",) else parent.replace("\\", "/")


def collect_moved_files(
    before: set[str], after: set[str], old_path: str, new_path: str
) -> list[dict]:
    """Derive files_moved from before/after path sets."""
    old_path = old_path.replace("\\", "/").rstrip("/")
    new_path = new_path.replace("\\", "/").rstrip("/")

    removed = sorted(before - after)
    added = sorted(after - before)

    moved: list[dict] = []
    used_added: set[str] = set()

    def map_path(old_rel: str) -> str | None:
        if old_rel == old_path:
            return new_path
        prefix = old_path + "/"
        if old_rel.startswith(prefix):
            return new_path + "/" + old_rel[len(prefix) :]
        return None

    for old_rel in removed:
        candidate = map_path(old_rel)
        if candidate and candidate in added:
            moved.append({"from": old_rel, "to": candidate})
            used_added.add(candidate)
        elif candidate and candidate in after:
            moved.append({"from": old_rel, "to": candidate})
            used_added.add(candidate)

    leftover_removed = [p for p in removed if not any(m["from"] == p for m in moved)]
    leftover_added = [p for p in added if p not in used_added]
    by_base: dict[str, list[str]] = {}
    for p in leftover_added:
        by_base.setdefault(os.path.basename(p), []).append(p)
    for old_rel in leftover_removed:
        base = os.path.basename(old_rel)
        options = by_base.get(base) or []
        if options:
            new_rel = options.pop(0)
            moved.append({"from": old_rel, "to": new_rel})

    if not moved:
        moved.append({"from": old_path, "to": new_path})

    return moved


def build_python_sandbox(repo_path: str) -> str:
    """
    Create a temporary tree containing COPIES of all Python sources.

    Content is fully copied (not hardlinked) so rope writes cannot mutate
    the real repository through shared inodes.
    """
    tmp = tempfile.mkdtemp(prefix="gitnexus-rope-move-")
    for rel in iter_python_files(repo_path):
        src = os.path.join(repo_path, rel)
        dst = os.path.join(tmp, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
    return tmp


def configure_project(project: Any, repo_path: str, old_path: str, source_folders: Any) -> None:
    """Apply source_folders + ignore prefs for faster, cleaner analysis."""
    folders = source_folders if isinstance(source_folders, list) else None
    if not folders:
        folders = infer_source_folders(repo_path, old_path)
    if folders:
        try:
            project.prefs.set("source_folders", folders)
        except Exception:
            pass
    # Ignore heavy / irrelevant trees (pattern list is rope-style)
    ignored = [
        "*~",
        "*.pyc",
        ".git",
        ".gitnexus",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        "dist",
        "build",
        "target",
        "coverage",
        ".next",
        ".ropeproject",
    ]
    try:
        project.prefs.set("ignored_resources", ignored)
    except Exception:
        pass


def perform_move(
    project: Any,
    old_path: str,
    new_path: str,
) -> None:
    """Apply rename and/or move on an open rope project (mutates that project root)."""
    from rope.refactor import move
    from rope.refactor.rename import Rename

    resource = project.get_resource(old_path)
    old_parent = parent_rel(old_path)
    new_parent = parent_rel(new_path)
    old_base = module_basename(old_path)
    new_base = module_basename(new_path)

    # Destination parent must exist for MoveModule
    ensure_folder(project, new_parent)

    if old_parent == new_parent:
        changes = Rename(project, resource).get_changes(new_base)
        project.do(changes)
    elif old_base == new_base:
        dest = ensure_folder(project, new_parent)
        mover = move.create_move(project, resource)
        changes = mover.get_changes(dest)
        project.do(changes)
    else:
        # Rename then move (both steps applied inside this project root only)
        rename_changes = Rename(project, resource).get_changes(new_base)
        project.do(rename_changes)
        mid_path = f"{old_parent}/{new_base}" if old_parent else new_base
        if resource.is_folder():
            mid_resource = project.get_resource(mid_path)
        else:
            ext = ""
            if old_path.endswith(PY_SUFFIXES):
                ext = os.path.splitext(old_path)[1]
            mid_resource = project.get_resource(mid_path + ext)
        dest = ensure_folder(project, new_parent)
        move_changes = move.create_move(project, mid_resource).get_changes(dest)
        project.do(move_changes)


def edits_from_snapshots(
    before_contents: dict[str, str],
    after_contents: dict[str, str],
    files_moved: list[dict],
) -> list[dict]:
    to_from = {m["to"]: m["from"] for m in files_moved}
    all_edits: list[dict] = []
    for rel, after_text in after_contents.items():
        if rel in before_contents:
            before_text = before_contents[rel]
            if before_text != after_text:
                all_edits.extend(compute_edits(before_text, after_text, rel))
        elif rel in to_from:
            old_rel = to_from[rel]
            before_text = before_contents.get(old_rel, "")
            if before_text != after_text:
                all_edits.extend(compute_edits(before_text, after_text, rel))
    return all_edits


def main() -> None:
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError) as e:
        print(json.dumps({"status": "error", "message": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    repo_path = input_data.get("repoPath", "")
    old_path = (input_data.get("oldPath") or "").replace("\\", "/").strip("/")
    new_path = (input_data.get("newPath") or "").replace("\\", "/").strip("/")
    dry_run = bool(input_data.get("dryRun", True))
    source_folders = input_data.get("sourceFolders")

    if not repo_path or not old_path or not new_path:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": "Missing required fields: repoPath, oldPath, newPath",
                }
            )
        )
        sys.exit(1)

    if old_path == new_path:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": "oldPath and newPath are identical",
                }
            )
        )
        sys.exit(1)

    abs_old = os.path.join(repo_path, old_path)
    abs_new = os.path.join(repo_path, new_path)

    if not os.path.exists(abs_old):
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": f"Source path does not exist: {old_path}",
                }
            )
        )
        sys.exit(1)

    if os.path.exists(abs_new):
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": f"Target path already exists: {new_path}",
                }
            )
        )
        sys.exit(1)

    try:
        from rope.base.project import Project
        from rope.base import exceptions
    except ImportError:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": "rope is not installed. Install it with: pip install rope",
                }
            )
        )
        sys.exit(1)

    project = None
    sandbox: str | None = None
    work_root = repo_path

    try:
        # ------------------------------------------------------------------
        # dry-run: isolated sandbox — real repo is never opened for writes
        # ------------------------------------------------------------------
        if dry_run:
            # Snapshot real tree first (for content diffs reported to caller)
            before_contents = snapshot_python_tree(repo_path)
            # Include non-py files under the moved path for files_moved reporting
            before_files = list_all_files(repo_path)

            sandbox = build_python_sandbox(repo_path)
            work_root = sandbox

            # If moving a directory that has non-py assets, those won't be in the
            # sandbox — that's fine for import rewrites. files_moved is derived
            # from the requested old/new path mapping + python files that moved.
            project = Project(work_root, ropefolder=None)
            configure_project(project, work_root, old_path, source_folders)

            if not os.path.exists(os.path.join(work_root, old_path)):
                # Source is a non-python-only path? Still need the resource.
                # For pure asset dirs this isn't a rope case — error clearly.
                print(
                    json.dumps(
                        {
                            "status": "error",
                            "message": (
                                f"No Python sources found at {old_path} "
                                "(rope move requires .py/.pyw/.pyi files)"
                            ),
                        }
                    )
                )
                sys.exit(1)

            perform_move(project, old_path, new_path)

            after_contents = snapshot_python_tree(work_root)
            after_files = set(after_contents.keys())
            # Map files_moved for python tree; ensure primary path is included
            py_before = set(before_contents.keys())
            files_moved = collect_moved_files(py_before, after_files, old_path, new_path)

            # If old_path is a directory, also report non-py children as moved
            # (logical mapping — sandbox didn't copy them but apply would)
            if os.path.isdir(abs_old):
                prefix = old_path.rstrip("/") + "/"
                for rel in before_files:
                    if rel.startswith(prefix) and not rel.endswith(PY_SUFFIXES):
                        dest = new_path.rstrip("/") + "/" + rel[len(prefix) :]
                        if not any(m["from"] == rel for m in files_moved):
                            files_moved.append({"from": rel, "to": dest})

            all_edits = edits_from_snapshots(before_contents, after_contents, files_moved)

            # Close project before deleting sandbox
            project.close()
            project = None

            print(
                json.dumps(
                    {
                        "status": "ok",
                        "edits": all_edits,
                        "files_moved": files_moved,
                    }
                )
            )
            sys.exit(0)

        # ------------------------------------------------------------------
        # apply: mutate the real repository
        # ------------------------------------------------------------------
        before_contents = snapshot_python_tree(repo_path)
        before_files = list_all_files(repo_path)

        project = Project(repo_path, ropefolder=None)
        configure_project(project, repo_path, old_path, source_folders)

        perform_move(project, old_path, new_path)

        after_contents = snapshot_python_tree(repo_path)
        after_files = list_all_files(repo_path)
        files_moved = collect_moved_files(before_files, after_files, old_path, new_path)
        all_edits = edits_from_snapshots(before_contents, after_contents, files_moved)

        print(
            json.dumps(
                {
                    "status": "ok",
                    "edits": all_edits,
                    "files_moved": files_moved,
                }
            )
        )
        sys.exit(0)

    except exceptions.ModuleSyntaxError as e:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": f"Syntax error in {e.filename} line {e.lineno}: {e.message_}",
                }
            )
        )
        sys.exit(1)
    except exceptions.ModuleDecodeError as e:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": f"Decode error in {e.filename}: {e.message_}",
                }
            )
        )
        sys.exit(1)
    except exceptions.RefactoringError as e:
        print(json.dumps({"status": "error", "message": f"Rope refactoring error: {e}"}))
        sys.exit(1)
    except exceptions.RopeError as e:
        print(json.dumps({"status": "error", "message": f"Rope error: {e}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"status": "error", "message": f"Unexpected error: {e}"}))
        sys.exit(1)
    finally:
        if project is not None:
            try:
                project.close()
            except Exception:
                pass
        if sandbox is not None:
            shutil.rmtree(sandbox, ignore_errors=True)


if __name__ == "__main__":
    main()
