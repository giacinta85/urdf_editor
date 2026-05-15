#!/usr/bin/env bash
# URDF Collision Body Visual Editor launcher
# Usage: ./run.sh

set -e
cd "$(dirname "$0")"

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
echo "  ║   Open: http://localhost:5000         ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

python app.py
