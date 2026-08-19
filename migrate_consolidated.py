#!/usr/bin/env python3
"""Move existing consolidated documents into their own folder.

GooseQuill used to write combiner output into the same ``Markdown/`` directory
as converted transcripts, which made a consolidation indistinguishable from a
document. It counted towards "converted", it appeared in the list of things to
consolidate — so combining a folder swept up yesterday's combination of that
folder — and its text matched every search twice, because a consolidation is a
copy of documents already in the workspace.

New consolidations go to ``<entity>/Consolidated/``. This moves the ones written
before that change.

Nothing moves unless you pass ``--apply``. Run it without that first and read
what it says.

    python migrate_consolidated.py            # show what would move
    python migrate_consolidated.py --apply    # move it
"""

import argparse
import sys
from pathlib import Path

# The banner MarkdownCombinerService writes at the head of everything it makes.
MARKER = "**Consolidated Archive**"
CONSOLIDATED_DIR_NAME = "Consolidated"


def find_workspace(project_root: Path) -> Path:
    accounts = project_root / "Accounts"
    return accounts if accounts.exists() else project_root / "documents"


def is_consolidated_document(path: Path) -> bool:
    """Whether a file is combiner output, judged by what it says about itself."""
    try:
        # The banner is in the first few lines; there is no need to read a 40MB
        # file to find out.
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            return MARKER in handle.read(4096)
    except OSError:
        return False


def plan(workspace: Path):
    """Every consolidation still sitting among the transcripts, and where it goes."""
    moves = []
    for path in sorted(workspace.rglob("*.md")):
        if not path.is_file():
            continue
        if CONSOLIDATED_DIR_NAME in path.parts:
            continue  # already moved
        if path.parent.name != "Markdown":
            continue
        if not is_consolidated_document(path):
            continue
        destination = path.parent.parent / CONSOLIDATED_DIR_NAME / path.name
        moves.append((path, destination))
    return moves


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="actually move the files")
    args = parser.parse_args()

    workspace = find_workspace(Path(__file__).resolve().parent)
    if not workspace.exists():
        print(f"No workspace found at {workspace}")
        return 1

    moves = plan(workspace)
    if not moves:
        print("Nothing to move — no consolidated documents are sitting among the transcripts.")
        return 0

    print(f"{len(moves)} consolidated document(s) in {workspace}:\n")
    for source, destination in moves:
        print(f"  {source.relative_to(workspace)}")
        print(f"    -> {destination.relative_to(workspace)}")

    if not args.apply:
        print("\nNothing has been moved. Re-run with --apply to move them.")
        return 0

    moved = 0
    for source, destination in moves:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            print(f"\nSkipped (something is already there): {destination}")
            continue
        source.rename(destination)
        moved += 1

    print(f"\nMoved {moved} document(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
