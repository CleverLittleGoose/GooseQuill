#!/usr/bin/env bash
# ==============================================================================
# GooseQuill Test Runner
# Automatically detects virtual environment and runs test suite.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

if [ -f "$SCRIPT_DIR/venv/bin/python" ]; then
    PYTHON_EXEC="$SCRIPT_DIR/venv/bin/python"
else
    PYTHON_EXEC="$(command -v python3 || command -v python)"
fi

echo "========================================================"
echo " 🧪 Running GooseQuill Test Suite..."
echo " 🐍 Python: $PYTHON_EXEC"
echo "========================================================"

exec "$PYTHON_EXEC" -m unittest discover tests "$@"
