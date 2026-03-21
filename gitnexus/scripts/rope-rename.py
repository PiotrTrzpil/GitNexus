"""
Rope-powered rename for Python files.

Communicates via stdin/stdout JSON. Designed to be invoked from Node.js
via child_process.

Input (JSON on stdin):
  { "repoPath": str, "filePath": str, "line": int, "column": int|null,
    "oldName": str, "newName": str, "dryRun": bool }

Output (JSON on stdout):
  Success:    { "status": "edits", "edits": [...] }
  Not found:  { "status": "not_found" }
  Error:      { "status": "error", "message": str }

Exit codes:
  0 — success (edits found or not_found)
  1 — error (message in JSON output)
"""

import json
import sys
import os

def find_offset(source: str, line: int, old_name: str, column: int | None = None) -> int | None:
    """Convert 1-based line + symbol name (or exact column) to a byte offset into source."""
    lines = source.split("\n")
    if line < 1 or line > len(lines):
        return None
    # Sum lengths of preceding lines (+1 for each \n) — the line start offset
    line_start = sum(len(l) + 1 for l in lines[: line - 1])
    if column is not None and column > 0:
        # Fast path: use the exact column directly
        return line_start + column
    # Regex fallback: find the symbol as a whole word on this line
    target_line = lines[line - 1]
    import re
    pattern = re.compile(r"\b" + re.escape(old_name) + r"\b")
    match = pattern.search(target_line)
    if not match:
        return None
    return line_start + match.start()


def compute_edits(source_before: str, source_after: str, file_path: str) -> list[dict]:
    """Diff two file contents and return per-line edits."""
    old_lines = source_before.split("\n")
    new_lines = source_after.split("\n")
    edits = []
    # For simple renames most lines stay the same — walk in parallel
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


def main() -> None:
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError) as e:
        print(json.dumps({"status": "error", "message": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    repo_path = input_data.get("repoPath", "")
    file_path = input_data.get("filePath", "")
    line = input_data.get("line", 0)
    column = input_data.get("column", None)
    old_name = input_data.get("oldName", "")
    new_name = input_data.get("newName", "")
    dry_run = input_data.get("dryRun", True)

    if not repo_path or not file_path or not old_name or not new_name or line < 1:
        print(
            json.dumps(
                {"status": "error", "message": "Missing or invalid required fields"}
            )
        )
        sys.exit(1)

    # Import rope (may not be installed)
    try:
        from rope.base.project import Project
        from rope.base.change import ChangeContents
        from rope.refactor.rename import Rename
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

    abs_file = os.path.join(repo_path, file_path)
    if not os.path.isfile(abs_file):
        print(json.dumps({"status": "not_found"}))
        sys.exit(0)

    project = None
    try:
        # ropefolder=None avoids creating .ropeproject in user's repo
        project = Project(repo_path, ropefolder=None)
        resource = project.get_resource(file_path)
        source = resource.read()

        offset = find_offset(source, line, old_name, column)
        if offset is None:
            print(json.dumps({"status": "not_found"}))
            sys.exit(0)

        try:
            renamer = Rename(project, resource, offset)
        except (
            exceptions.RefactoringError,
            exceptions.BadIdentifierError,
        ):
            print(json.dumps({"status": "not_found"}))
            sys.exit(0)

        try:
            changes = renamer.get_changes(new_name, docs=False)
        except exceptions.RefactoringError as e:
            print(json.dumps({"status": "error", "message": str(e)}))
            sys.exit(1)

        # Build edits from the changes
        all_edits: list[dict] = []
        for change in changes.changes:
            if isinstance(change, ChangeContents):
                rel_path = change.resource.path
                old_content = change.resource.read()
                new_content = change.new_contents
                all_edits.extend(compute_edits(old_content, new_content, rel_path))

        if not all_edits:
            print(json.dumps({"status": "not_found"}))
            sys.exit(0)

        # Apply if not dry run
        if not dry_run:
            project.do(changes)

        print(json.dumps({"status": "edits", "edits": all_edits}))
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
    except exceptions.ResourceNotFoundError as e:
        print(json.dumps({"status": "not_found"}))
        sys.exit(0)
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


if __name__ == "__main__":
    main()
