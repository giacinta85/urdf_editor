"""
URDF Collision Body Visual Editor - Flask Backend
Run: python app.py
Open: http://localhost:${PORT:-5173}
"""
from flask import Flask, jsonify, request, render_template, send_file, abort, Response
from pathlib import Path
import os

from scripts.urdf_to_mjcf import find_paths_for_urdf, generate_mjcf

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


@app.route("/api/save_xml", methods=["POST"])
def save_xml():
    """Save the current URDF and generate/update its matching MJCF XML."""
    data = request.get_json(force=True)
    path = data.get("path", "")
    content = data.get("content", "")
    if not path or not content:
        abort(400, "Missing path or content")

    full = _safe_path(path)
    if not full.exists():
        abort(404)
    full.write_text(content, encoding="utf-8")

    try:
        urdf_path, template_path, output_path = find_paths_for_urdf(ASSETS_DIR, path)
        result = generate_mjcf(urdf_path, template_path, output_path)
    except Exception as exc:
        abort(500, str(exc))

    return jsonify({
        "ok": True,
        "xml_path": str(result["output"]),
        "xml_rel_path": str(Path(result["output"]).relative_to(ASSETS_DIR)),
        "template_rel_path": str(Path(result["template"]).relative_to(ASSETS_DIR)),
    })


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
    port = int(os.environ.get("PORT", "5173"))
    print(f"[URDF Editor] Assets dir : {ASSETS_DIR}")
    print(f"[URDF Editor] Open        : http://localhost:{port}")
    app.run(debug=True, port=port, host="0.0.0.0")
