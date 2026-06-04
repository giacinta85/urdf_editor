/**
 * gizmo.js
 * Wraps THREE.TransformControls.
 *
 * Modes:
 *   translate (T) – move the collision origin
 *   rotate    (R) – rotate the collision origin (rpy)
 *   scale     (S) – non-uniformly resize the geometry dimensions
 *
 * On drag-end the gizmo calls:
 *   onTransformEnd({ id, origin, geometry })
 * with the updated collision data.
 *
 * On each change (live feedback) during drag:
 *   onTransformChange({ id, origin, geometry })
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export class CollisionGizmo {
  /**
   * @param {THREE.Scene}          scene
   * @param {THREE.Camera}         camera
   * @param {THREE.WebGLRenderer}  renderer
   * @param {OrbitControls}        orbit
   * @param {function}             onTransformChange  – live feedback
   * @param {function}             onTransformEnd     – commit
   */
  constructor(scene, camera, renderer, orbit, onTransformChange, onTransformEnd) {
    this._scene    = scene;
    this._camera   = camera;
    this._orbit    = orbit;
    this._onChange = onTransformChange;
    this._onEnd    = onTransformEnd;

    this._ctrl = new TransformControls(camera, renderer.domElement);
    this._ctrl.setSize(0.75);
    scene.add(this._ctrl);

    // Disable orbit while dragging gizmo
    this._ctrl.addEventListener('dragging-changed', (e) => {
      orbit.enabled = !e.value;
    });

    this._ctrl.addEventListener('change', () => this._handleChange());
    this._ctrl.addEventListener('mouseUp',  () => this._handleEnd());

    this._attachedId     = null;
    this._attachedCol    = null;  // reference to live CollisionObj
    this._attachedGroup  = null;
    this._baseDims       = null;  // geometry snapshot when scale starts
    this._baseMatrix     = null;  // transform snapshot for live scale preview
    this._baseOriginPos  = null;  // position snapshot for translate
    this._baseOriginRot  = null;  // quaternion snapshot for rotate
    this._mode           = 'translate';
    this._dragging       = false;

    this._ctrl.addEventListener('mouseDown', () => {
      this._dragging = true;
      if (this._mode === 'scale' && this._attachedCol) {
        this._baseDims = { ...this._attachedCol.geometry };
        this._baseMatrix = this._ctrl.object.matrix.clone();
      }
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────

  attach(group, col) {
    this._attachedId  = col.id;
    this._attachedCol = col;
    this._attachedGroup = group;
    this._ctrl.attach(group);
    this._applyMode(this._mode);
    this._dragging = false;
  }

  detach() {
    this._ctrl.detach();
    this._attachedId  = null;
    this._attachedCol = null;
    this._attachedGroup = null;
    this._baseDims    = null;
    this._baseMatrix  = null;
    this._dragging    = false;
  }

  setMode(mode) {
    this._mode = mode;
    this._applyMode(mode);
  }

  getMode() { return this._mode; }

  isAttached() { return this._attachedId !== null; }

  _applyMode(mode) {
    if (mode === 'translate' || mode === 'scale') {
      // Movement/resize is keyboard/form-only. Hiding TransformControls avoids
      // accidental arrow-handle drags while keeping selection active.
      this._ctrl.detach();
    } else {
      if (this._attachedGroup) this._ctrl.attach(this._attachedGroup);
      this._ctrl.setMode(mode); // 'rotate'
    }
  }

  // ── Live change handler ────────────────────────────────────────────────

  _handleChange() {
    if (!this._attachedCol || !this._dragging) return;
    const col   = this._attachedCol;
    const group = this._ctrl.object;

    if (this._mode === 'translate') {
      // Decompose world position back to local (link) space
      const worldPos = new THREE.Vector3();
      group.getWorldPosition(worldPos);
      // origin.xyz is relative to link frame; we'll compute on End for accuracy
      // For live feedback just emit current world position as delta hint
      // (full recompute done in _handleEnd)
      this._onChange({ id: col.id, live: true });

    } else if (this._mode === 'rotate') {
      this._onChange({ id: col.id, live: true });

    } else if (this._mode === 'scale' && this._baseDims) {
      const s = group.scale;
      this._applyScaleToDims(col, s);
      this._applyLiveScalePreview(group, s);
      this._onChange({ id: col.id, live: true });
    }
  }

  // ── Commit handler ─────────────────────────────────────────────────────

  _handleEnd() {
    if (!this._attachedCol) return;
    this._dragging = false;
    const col   = this._attachedCol;
    const group = this._ctrl.object;

    if (this._mode === 'translate') {
      // Extract position from group.matrix (which is in link-local space because
      // we set group.matrix = linkWorldT × colOriginT; but group position IS world
      // because we disabled matrixAutoUpdate and used matrix directly)
      //
      // Actually: group.position is in world space (Three.js maintains it).
      // We need to compute col.origin.xyz = inv(linkWorldT) × group.position.
      // The linkWorldT is stored externally; we emit the group and let app.js compute.
      const pos = new THREE.Vector3();
      group.getWorldPosition(pos);
      this._onEnd({ id: col.id, mode: 'translate', worldPos: pos });

    } else if (this._mode === 'rotate') {
      const quat = new THREE.Quaternion();
      group.getWorldQuaternion(quat);
      this._onEnd({ id: col.id, mode: 'rotate', worldQuat: quat });

    } else if (this._mode === 'scale' && this._baseDims) {
      const s = group.scale.clone();
      this._applyScaleToDims(col, s);
      // Reset mesh scale to 1 (actual resize is in geometry, not scale transform)
      group.scale.set(1, 1, 1);
      // Pass baseDims so app.js can build undo entry with pre-drag geometry
      this._onEnd({ id: col.id, mode: 'scale', geometry: { ...col.geometry }, baseDims: { ...this._baseDims } });
    }
  }

  _applyScaleToDims(col, scale) {
    const base = this._baseDims;
    if (!base) return;
    const g = col.geometry;

    if (base.type === 'box') {
      g.sx = Math.max(0.001, base.sx * Math.abs(scale.x));
      g.sy = Math.max(0.001, base.sy * Math.abs(scale.y));
      g.sz = Math.max(0.001, base.sz * Math.abs(scale.z));
    } else if (base.type === 'cylinder') {
      // geometry has baked X-rotation: Y-axis = length, X/Z = radius
      g.radius = Math.max(0.001, base.radius * ((Math.abs(scale.x) + Math.abs(scale.z)) / 2));
      g.length = Math.max(0.001, base.length * Math.abs(scale.y));
    } else {
      g.radius = Math.max(0.001, base.radius * ((Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3));
    }
  }

  _applyLiveScalePreview(group, scale) {
    if (!this._baseMatrix) return;
    group.matrix.copy(this._baseMatrix).scale(scale);
    group.matrixWorldNeedsUpdate = true;
    group.updateMatrixWorld(true);
  }
}
