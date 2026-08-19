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

# 3. Refuse to fight for the port
#
# Started twice, this printed "[Errno 48] address already in use" from deep in
# uvicorn — after the browser helper below had already opened a window against
# the server that was *already* running. So it looked like it had both worked
# and failed. If GooseQuill is up, just go to it.
PORT="${GOOSEQUILL_PORT:-8000}"

if command -v lsof >/dev/null 2>&1; then
    EXISTING_PID="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
else
    EXISTING_PID=""
fi

if [ -n "$EXISTING_PID" ]; then
    EXISTING_CMD="$(ps -p "$EXISTING_PID" -o command= 2>/dev/null)"

    case "$EXISTING_CMD" in
        *app.py*)
            echo "✅ GooseQuill is already running (PID $EXISTING_PID)."
            echo "   Opening http://127.0.0.1:$PORT"
            command -v open >/dev/null 2>&1 && open "http://127.0.0.1:$PORT"
            exit 0
            ;;
        *)
            echo "❌ Port $PORT is in use by something else (PID $EXISTING_PID):"
            echo "   $EXISTING_CMD"
            echo
            echo "   Stop it, or start GooseQuill on another port:"
            echo "     GOOSEQUILL_PORT=8010 $0"
            exit 1
            ;;
    esac
fi

# 4. Background helper to auto-open the browser once server is responsive
(
    # Wait for the server to be up (up to 10 seconds)
    for i in {1..20}; do
        if curl -s "http://127.0.0.1:$PORT/favicon.ico" >/dev/null 2>&1; then
            break
        fi
        sleep 0.5
    done

    # Open default browser
    if command -v open >/dev/null 2>&1; then
        open "http://127.0.0.1:$PORT"
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "http://127.0.0.1:$PORT"
    fi
) &

# 5. Start the application
exec "$SCRIPT_DIR/venv/bin/python" "$SCRIPT_DIR/app.py"
