#!/usr/bin/env bash
# ==============================================================================
# GooseQuill Test Runner
#
# Two suites: the Python backend, and the frontend modules that carry real
# logic. The frontend tests use Node's built-in runner — no dependency to
# install, and skipped with a warning rather than a failure if Node is absent,
# since the app itself does not need it.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR" || exit 1

if [ -f "$SCRIPT_DIR/venv/bin/python" ]; then
    PYTHON_EXEC="$SCRIPT_DIR/venv/bin/python"
else
    PYTHON_EXEC="$(command -v python3 || command -v python)"
fi

echo "========================================================"
echo " 🧪 Running GooseQuill Test Suite..."
echo " 🐍 Python: $PYTHON_EXEC"
echo "========================================================"

"$PYTHON_EXEC" -m unittest discover tests "$@"
PYTHON_STATUS=$?

echo
echo "========================================================"
echo " 🌐 Frontend tests"
echo "========================================================"

if command -v node >/dev/null 2>&1; then
    node --test "tests/frontend/*.test.mjs"
    NODE_STATUS=$?
else
    echo " ⚠️  Node not found — skipping frontend tests."
    NODE_STATUS=0
fi

if [ $PYTHON_STATUS -ne 0 ] || [ $NODE_STATUS -ne 0 ]; then
    exit 1
fi
exit 0
