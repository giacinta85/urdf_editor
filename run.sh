#!/usr/bin/env bash
# URDF Collision Body Visual Editor launcher
# Usage: ./run.sh

set -e
cd "$(dirname "$0")"

PORT="${PORT:-5173}"

# Check if conda env is active or create it
if ! python -c "import flask" 2>/dev/null; then
    echo "[setup] Flask not found. Creating conda env 'urdf_editor'..."
    conda env create -f environment.yml || conda env update -f environment.yml
    eval "$(conda shell.bash hook)"
    conda activate urdf_editor
fi

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   URDF Collision Body Editor         ║"
printf "  ║   Open: http://localhost:%-10s║\n" "$PORT"
echo "  ╚══════════════════════════════════════╝"
echo ""

PIDS="$(lsof -ti tcp:"$PORT" || true)"
if [ -n "$PIDS" ]; then
    echo "[setup] Port $PORT is in use. Stopping existing process: $PIDS"
    kill $PIDS
    sleep 0.5
fi

PORT="$PORT" python app.py
