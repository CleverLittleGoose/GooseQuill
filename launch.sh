#!/usr/bin/env bash
# ==============================================================================
# GooseQuill Launcher
# Starts the FastAPI backend and opens the web interface in your default browser.
# ==============================================================================

# Resolve the root directory of this script, even when called via alias/symlink
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$SCRIPT_DIR"

echo "========================================================"
echo " 🚀 Launching GooseQuill..."
echo " 📁 Working Directory: $SCRIPT_DIR"
echo "========================================================"

# 1. Check for Virtual Environment
if [ ! -d "$SCRIPT_DIR/venv" ]; then
    echo "❌ Virtual environment not found at $SCRIPT_DIR/venv"
    echo "Creating virtual environment and installing dependencies..."
    python3 -m venv "$SCRIPT_DIR/venv"
    "$SCRIPT_DIR/venv/bin/pip" install --upgrade pip
    "$SCRIPT_DIR/venv/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"
fi

# 2. Check for .env Configuration
if [ ! -f "$SCRIPT_DIR/.env" ]; then
    echo "⚠️  Warning: No .env file found in $SCRIPT_DIR"
    echo "Please make sure PDF_MARKDOWN_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY is set."
fi

# 3. Background helper to auto-open the browser once server is responsive
(
    # Wait for the server to be up (up to 10 seconds)
    for i in {1..20}; do
        if curl -s http://localhost:8000/favicon.ico >/dev/null 2>&1; then
            break
        fi
        sleep 0.5
    done

    # Open default browser
    if command -v open >/dev/null 2>&1; then
        open "http://localhost:8000"
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "http://localhost:8000"
    fi
) &

# 4. Start the application
exec "$SCRIPT_DIR/venv/bin/python" "$SCRIPT_DIR/app.py"
