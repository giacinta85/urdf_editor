/**
 * ui_props.js
 * Right-panel property editor for a selected collision body.
 *
 * Emits change events immediately on input; the app debounces them.
 */

export class PropsPanel {
  /**
 * @param {function} onOriginChange   (id, origin)
 * @param {function} onGeometryChange (id, geometry)
 * @param {function} onDuplicate      (id)
 * @param {function} onMirror         (id)
 * @param {function} onMirrorLink     (id)
 * @param {function} onDelete         (id)
 */
  constructor({ onOriginChange, onGeometryChange, onDuplicate, onMirror, onMirrorLink, onDelete }) {
    this._onOriginChange   = onOriginChange;
    this._onGeometryChange = onGeometryChange;
    this._onDuplicate      = onDuplicate;
    this._onMirror         = onMirror;
    this._onMirrorLink     = onMirrorLink;
    this._onDelete         = onDelete;

    this._currentId = null;
    this._suppressEvents = false;

    this._empty  = document.getElementById('props-empty');
    this._editor = document.getElementById('props-editor');

    // Origin fields
    this._ox  = document.getElementById('p-ox');
    this._oy  = document.getElementById('p-oy');
    this._oz  = document.getElementById('p-oz');
    this._or  = document.getElementById('p-or');
    this._op  = document.getElementById('p-op');
    this._oy2 = document.getElementById('p-oy2');

    // Geometry type
    this._gtype = document.getElementById('p-gtype');

    // Param divs
    this._paramBox    = document.getElementById('params-box');
    this._paramCyl    = document.getElementById('params-cylinder');
    this._paramSph    = document.getElementById('params-sphere');

    // Box
    this._bx = document.getElementById('p-bx');
    this._by = document.getElementById('p-by');
    this._bz = document.getElementById('p-bz');

    // Cylinder
    this._cr = document.getElementById('p-cr');
    this._cl = document.getElementById('p-cl');

    // Sphere
    this._sr = document.getElementById('p-sr');

    // Buttons
    document.getElementById('btn-duplicate').addEventListener('click', () => {
      if (this._currentId) this._onDuplicate(this._currentId);
    });
    document.getElementById('btn-mirror-col').addEventListener('click', () => {
      if (this._currentId) this._onMirror(this._currentId);
    });
    document.getElementById('btn-mirror-link').addEventListener('click', () => {
      if (this._currentId) this._onMirrorLink(this._currentId);
    });
    document.getElementById('btn-delete-col').addEventListener('click', () => {
      if (this._currentId) this._onDelete(this._currentId);
    });

    this._bindInputs();
  }

  // ── Public ──────────────────────────────────────────────────────────────

  show(col) {
    this._currentId = col.id;
    this._empty.style.display  = 'none';
    this._editor.style.display = 'block';
    this._populate(col);
  }

  hide() {
    this._currentId = null;
    this._empty.style.display  = 'flex';
    this._editor.style.display = 'none';
  }

  /** Silently update form values without firing change events (e.g. after gizmo drag). */
  updateValues(col) {
    this._suppressEvents = true;
    this._populate(col);
    this._suppressEvents = false;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _populate(col) {
    const { origin, geometry } = col;

    this._ox.value  = this._fmt(origin.xyz.x);
    this._oy.value  = this._fmt(origin.xyz.y);
    this._oz.value  = this._fmt(origin.xyz.z);
    this._or.value  = this._fmt(origin.rpy.roll);
    this._op.value  = this._fmt(origin.rpy.pitch);
    this._oy2.value = this._fmt(origin.rpy.yaw);

    this._gtype.value = geometry.type;
    this._showGeomParams(geometry.type);

    if (geometry.type === 'box') {
      this._bx.value = this._fmt(geometry.sx);
      this._by.value = this._fmt(geometry.sy);
      this._bz.value = this._fmt(geometry.sz);
    } else if (geometry.type === 'cylinder') {
      this._cr.value = this._fmt(geometry.radius);
      this._cl.value = this._fmt(geometry.length);
    } else {
      this._sr.value = this._fmt(geometry.radius);
    }
  }

  _showGeomParams(type) {
    this._paramBox.style.display = type === 'box'      ? 'grid' : 'none';
    this._paramCyl.style.display = type === 'cylinder' ? 'grid' : 'none';
    this._paramSph.style.display = type === 'sphere'   ? 'grid' : 'none';
  }

  _fmt(n) {
    if (!isFinite(n)) return '0';
    return parseFloat(n.toFixed(6)).toString();
  }

  _bindInputs() {
    const originFields = [this._ox, this._oy, this._oz, this._or, this._op, this._oy2];
    for (const el of originFields) {
      el.addEventListener('input', () => this._emitOrigin());
    }

    // Geometry type change
    this._gtype.addEventListener('change', () => {
      if (this._suppressEvents || !this._currentId) return;
      this._showGeomParams(this._gtype.value);
      this._emitGeometry();
    });

    // Box params
    for (const el of [this._bx, this._by, this._bz]) {
      el.addEventListener('input', () => this._emitGeometry());
    }
    // Cylinder params
    for (const el of [this._cr, this._cl]) {
      el.addEventListener('input', () => this._emitGeometry());
    }
    // Sphere param
    this._sr.addEventListener('input', () => this._emitGeometry());
  }

  _emitOrigin() {
    if (this._suppressEvents || !this._currentId) return;
    const origin = {
      xyz: {
        x: parseFloat(this._ox.value)  || 0,
        y: parseFloat(this._oy.value)  || 0,
        z: parseFloat(this._oz.value)  || 0
      },
      rpy: {
        roll:  parseFloat(this._or.value)  || 0,
        pitch: parseFloat(this._op.value)  || 0,
        yaw:   parseFloat(this._oy2.value) || 0
      }
    };
    this._onOriginChange(this._currentId, origin);
  }

  _emitGeometry() {
    if (this._suppressEvents || !this._currentId) return;
    const type = this._gtype.value;
    let geometry;
    if (type === 'box') {
      geometry = {
        type,
        sx: Math.max(0.001, parseFloat(this._bx.value) || 0.05),
        sy: Math.max(0.001, parseFloat(this._by.value) || 0.05),
        sz: Math.max(0.001, parseFloat(this._bz.value) || 0.05)
      };
    } else if (type === 'cylinder') {
      geometry = {
        type,
        radius: Math.max(0.001, parseFloat(this._cr.value) || 0.04),
        length: Math.max(0.001, parseFloat(this._cl.value) || 0.08)
      };
    } else {
      geometry = {
        type,
        radius: Math.max(0.001, parseFloat(this._sr.value) || 0.04)
      };
    }
    this._onGeometryChange(this._currentId, geometry);
  }
}
