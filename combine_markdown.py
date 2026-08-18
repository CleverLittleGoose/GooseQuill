#!/usr/bin/env python3
"""
GooseQuill: Markdown Consolidation & Combiner Tool (Compatibility Wrapper).
Delegates to unified `cli.py combine`.
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import cli

if __name__ == "__main__":
    # If called without subcommand, inject 'combine'
    if len(sys.argv) == 1 or sys.argv[1] not in ("convert", "combine", "serve"):
        sys.argv.insert(1, "combine")
    cli.main()
