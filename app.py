"""
URDF Collision Body Visual Editor - Flask Backend
Run: python app.py
Open: http://localhost:5173
"""
from flask import Flask, jsonify, request, render_template, send_file, abort, Response
from pathlib import Path
import os

app = Flask(__name__)

BASE_DIR   = Path(__file__).parent
ASSETS_DIR = BASE_DIR / "robots"


def _safe_path(rel: str) -> Path:
    """Resolve a relative path safely under ASSETS_DIR."""
    full = (ASSETS_DIR / rel).resolve()
    if not str(full).startswith(str(ASSETS_DIR.resolve())):
        abort(403, "Forbidden path")
    return full


# ── Pages ─────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ── API ───────────────────────────────────────────────────────────────────────

@app.route("/api/files")
def list_files():
    """List all URDF files under robots/."""
    files = []
    for urdf in sorted(ASSETS_DIR.rglob("*.urdf")):
        rel = str(urdf.relative_to(ASSETS_DIR))
        label = urdf.stem + "  (" + str(urdf.relative_to(ASSETS_DIR).parent) + ")"
        files.append({"label": label, "path": rel})
    return jsonify(files)


@app.route("/api/urdf")
def get_urdf():
    """Return raw URDF XML text."""
    path = request.args.get("path", "")
    if not path:
        abort(400, "Missing path parameter")
    full = _safe_path(path)
    if not full.exists():
        abort(404)
    content = full.read_text(encoding="utf-8")
    return Response(content, mimetype="application/xml")


@app.route("/api/save", methods=["POST"])
def save_urdf():
    """Overwrite a URDF file with new content."""
    data = request.get_json(force=True)
    path    = data.get("path", "")
    content = data.get("content", "")
    if not path or not content:
        abort(400, "Missing path or content")
    full = _safe_path(path)
    if not full.exists():
        abort(404)
    full.write_text(content, encoding="utf-8")
    return jsonify({"ok": True})


# ── Static mesh serving ────────────────────────────────────────────────────────

@app.route("/mesh/<path:filepath>")
def serve_mesh(filepath: str):
    """Serve STL / mesh files from robots/."""
    full = _safe_path(filepath)
    if not full.exists():
        abort(404)
    return send_file(full)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"[URDF Editor] Assets dir : {ASSETS_DIR}")
    print(f"[URDF Editor] Open        : http://localhost:5173")
    app.run(debug=True, port=5173, host="0.0.0.0")
