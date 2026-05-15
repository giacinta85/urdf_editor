/**
 * app.js  –  Main application wiring
 *
 * Responsibilities:
 *  - Fetch file list + populate dropdown
 *  - Load URDF → parse → FK → build scene
 *  - Coordinate selection between 3D scene, tree, props panel
 *  - Forward gizmo drag-end into data model (origin / geometry updates)
 *  - Save URDF with format-preserving serialization
 *  - Keyboard shortcuts (T/R/S/Esc/Delete/arrows/Cmd+Z)
 */
import * as THREE from 'three';
import {
  parseURDF, computeFK, resolveMeshUrl,
  buildSaveXML, createDefaultCollision, originToMatrix4
} from './urdf_parser.js';
import { URDFScene, collisionWorldMatrix } from './scene.js';
import { CollisionGizmo }  from './gizmo.js';
import { LinkTree }        from './ui_tree.js';
import { PropsPanel }      from './ui_props.js';

// ── State ──────────────────────────────────────────────────────────────────

const S = {
  filePath:    null,
  originalXML: null,
  robotData:   null,
  fkT:         null,   // { linkName: THREE.Matrix4 }
  selId:       null,
  selLink:     null,
};

// ── Undo stack ─────────────────────────────────────────────────────────────

const UNDO_STACK = [];
const UNDO_MAX   = 80;
let _undoDebounce = { id: null, time: 0 };

/**
 * Push a snapshot of col's current state onto the undo stack.
 * @param {object} col
 * @param {string} linkName
 * @param {boolean} [deletedAs]  override the deleted field (for add-collision undo)
 */
function _pushUndo(col, linkName, deletedAs = col.deleted) {
  UNDO_STACK.push({
    id:       col.id,
    linkName,
    origin:   JSON.parse(JSON.stringify(col.origin)),
    geometry: JSON.parse(JSON.stringify(col.geometry)),
    deleted:  deletedAs
  });
  if (UNDO_STACK.length > UNDO_MAX) UNDO_STACK.shift();
}

/**
 * Like _pushUndo but suppresses duplicate pushes for the same collision
 * within 800 ms — avoids creating one undo entry per keystroke in form inputs.
 */
function _pushUndoDeduped(col, linkName) {
  const now = Date.now();
  if (_undoDebounce.id === col.id && now - _undoDebounce.time < 800) return;
  _pushUndo(col, linkName);
  _undoDebounce = { id: col.id, time: now };
}

function _undo() {
  const entry = UNDO_STACK.pop();
  if (!entry) return;
  const col = _getCollision(entry.id);
  if (!col) return;

  const wasDel = col.deleted;
  col.origin   = entry.origin;
  col.geometry = JSON.parse(JSON.stringify(entry.geometry));
  col.deleted  = entry.deleted;
  col.dirty    = true;

  if (!wasDel && entry.deleted) {
    // Was alive → undo makes it deleted (undo of "add")
    Scene.removeCollisionMesh(entry.id);
    if (S.selId === entry.id) deselect();
  } else if (wasDel && !entry.deleted) {
    // Was deleted → undo restores it (undo of "delete")
    Scene.addCollisionMesh(entry.linkName, col, S.fkT[entry.linkName]);
    selectCollision(entry.id, entry.linkName);
  } else if (!col.deleted) {
    // Origin / geometry edit
    _rebuildMesh(entry.id);
    if (S.selId === entry.id) Props.updateValues(col);
  }

  Tree.render(S.robotData, S.selId);
  _undoDebounce = { id: null, time: 0 }; // allow fresh push after undo
}

// ── Module instances ───────────────────────────────────────────────────────

const canvas   = document.getElementById('three-canvas');
const Scene    = new URDFScene(canvas);
const Gizmo    = new CollisionGizmo(
  Scene.scene, Scene.camera, Scene.renderer, Scene.orbit,
  _onGizmoChange, _onGizmoEnd
);

const Tree  = new LinkTree(document.getElementById('link-tree'), {
  onSelectCollision: selectCollision,
  onDeleteCollision: deleteCollision,
  onAddCollision:    addCollision,
  onFocusLink:       (ln) => Scene.focusOnLink(ln)
});

const Props = new PropsPanel({
  onOriginChange:   _onOriginChange,
  onGeometryChange: _onGeometryChange,
  onDuplicate:      duplicateCollision,
  onDelete:         deleteCollision
});

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  await fetchFileList();
  bindTopbar();
  bindKeyboard();
  Scene.onCollisionClick((id, linkName) => {
    if (id) selectCollision(id, linkName);
    else    deselect();
  });
  hideLoading();
}

// ── File list ──────────────────────────────────────────────────────────────

async function fetchFileList() {
  try {
    const files = await fetch('/api/files').then(r => r.json());
    const sel = document.getElementById('urdf-select');
    for (const f of files) {
      const opt = document.createElement('option');
      opt.value = f.path;
      opt.textContent = f.label;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      if (sel.value) loadURDF(sel.value);
    });
  } catch (e) {
    console.error('Failed to fetch file list:', e);
  }
}

// ── Load URDF ──────────────────────────────────────────────────────────────

async function loadURDF(path) {
  showLoading('加载中…');
  deselect();
  S.filePath = path;
  S.robotData = null;
  S.fkT = null;

  try {
    const xml = await fetch(`/api/urdf?path=${encodeURIComponent(path)}`).then(r => r.text());
    S.originalXML = xml;
    S.robotData   = parseURDF(xml);
    S.fkT         = computeFK(S.robotData);

    await Scene.loadRobot(S.robotData, S.fkT, path, resolveMeshUrl);
    Tree.render(S.robotData, null);

    document.getElementById('btn-save').disabled = false;
    showLoading('渲染 STL 中…');
    // STL loading is async inside scene; loading overlay hides on next tick
    setTimeout(hideLoading, 200);
  } catch (err) {
    console.error('Failed to load URDF:', err);
    showLoading('加载失败: ' + err.message);
    setTimeout(hideLoading, 3000);
  }
}

// ── Selection ──────────────────────────────────────────────────────────────

function selectCollision(id, linkName) {
  if (!S.robotData) return;

  // Resolve linkName if not provided (e.g. from gizmo)
  if (!linkName) linkName = _findLinkOfCollision(id);
  if (!linkName) return;

  S.selId   = id;
  S.selLink = linkName;

  Scene.selectCollision(id);
  Scene.focusOnCollision(id);   // 视角跟随选中的碰撞体
  Tree.setSelected(id);
  Tree.scrollToCollision(id);

  const col = _getCollision(id);
  if (col) Props.show(col);

  // Attach gizmo
  const group = Scene.getCollisionGroup(id);
  if (group) {
    Gizmo.attach(group, col);
    Gizmo.setMode(_currentGizmoMode());
  }
}

function deselect() {
  S.selId   = null;
  S.selLink = null;
  Scene.deselectCollision();
  Gizmo.detach();
  Props.hide();
  Tree.setSelected(null);
}

// ── Collision CRUD ─────────────────────────────────────────────────────────

function addCollision(linkName, type) {
  if (!S.robotData) return;
  const col = createDefaultCollision(type);
  S.robotData.links[linkName].collisions.push(col);
  // Push undo: to undo this add, the col should be marked deleted
  _pushUndo(col, linkName, true);

  const linkWorldT = S.fkT[linkName];
  Scene.addCollisionMesh(linkName, col, linkWorldT);
  Tree.render(S.robotData, col.id);
  selectCollision(col.id, linkName);
}

function deleteCollision(id) {
  if (!S.robotData) return;
  const col = _getCollision(id);
  if (!col) return;
  const linkName = _findLinkOfCollision(id);
  // Push undo before marking deleted (captures alive state)
  _pushUndo(col, linkName);

  col.deleted = true;
  col.dirty   = true;

  Scene.removeCollisionMesh(id);
  if (S.selId === id) deselect();
  Tree.render(S.robotData, S.selId);
}

function duplicateCollision(id) {
  if (!S.robotData || !S.selLink) return;
  const col = _getCollision(id);
  if (!col) return;

  const newCol = createDefaultCollision(col.geometry.type);
  newCol.origin   = JSON.parse(JSON.stringify(col.origin));
  newCol.geometry = { ...col.geometry };
  // Offset slightly so it's visible
  newCol.origin.xyz.x += 0.01;
  newCol.dirty = true;

  const link = S.robotData.links[S.selLink];
  link.collisions.push(newCol);
  // Push undo: to undo this duplicate, the newCol should be marked deleted
  _pushUndo(newCol, S.selLink, true);

  Scene.addCollisionMesh(S.selLink, newCol, S.fkT[S.selLink]);
  Tree.render(S.robotData, newCol.id);
  selectCollision(newCol.id, S.selLink);
}

// ── Origin / geometry changes from props form ──────────────────────────────

// Debounce: wait 200 ms after last keystroke before rebuilding mesh
let _debounceTimer = null;

function _onOriginChange(id, origin) {
  const col = _getCollision(id);
  if (!col) return;
  _pushUndoDeduped(col, S.selLink);  // push before first change
  col.origin = origin;
  col.dirty  = true;
  _scheduleRebuild(id);
}

function _onGeometryChange(id, geometry) {
  const col = _getCollision(id);
  if (!col) return;
  _pushUndoDeduped(col, S.selLink);  // push before first change
  col.geometry = geometry;
  col.dirty    = true;
  _scheduleRebuild(id);
}

function _scheduleRebuild(id) {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => _rebuildMesh(id), 150);
}

function _rebuildMesh(id) {
  if (!S.selLink) return;
  const col = _getCollision(id);
  if (!col) return;
  const linkWorldT = S.fkT[S.selLink];
  const group = Scene.updateCollisionMesh(col, linkWorldT);

  // Re-attach gizmo to the new group
  if (group && S.selId === id) {
    Gizmo.attach(group, col);
    Gizmo.setMode(_currentGizmoMode());
  }
}

// ── Gizmo event handlers ───────────────────────────────────────────────────

function _onGizmoChange({ id, live }) {
  // Live feedback during scale drag: update form fields
  if (live && S.selId === id) {
    const col = _getCollision(id);
    if (col) Props.updateValues(col);
  }
}

function _onGizmoEnd({ id, mode, worldPos, worldQuat, geometry, baseDims }) {
  if (!S.robotData || !S.selLink) return;
  const col = _getCollision(id);
  if (!col) return;

  const linkWorldT = S.fkT[S.selLink];

  if (mode === 'translate' && worldPos) {
    // col.origin.xyz is still pre-drag at this point → push undo before modifying
    _pushUndo(col, S.selLink);

    const invLink = linkWorldT.clone().invert();
    const localPos = worldPos.clone().applyMatrix4(invLink);
    col.origin.xyz = { x: localPos.x, y: localPos.y, z: localPos.z };
    col.dirty = true;

    const group = Scene.getCollisionGroup(id);
    if (group) {
      group.matrix.copy(collisionWorldMatrix(linkWorldT, col));
      group.matrixWorldNeedsUpdate = true;
    }
    Props.updateValues(col);

  } else if (mode === 'rotate' && worldQuat) {
    // col.origin.rpy is still pre-drag at this point → push undo before modifying
    _pushUndo(col, S.selLink);

    const linkWorldQ = new THREE.Quaternion().setFromRotationMatrix(linkWorldT);
    const invLinkQ   = linkWorldQ.clone().invert();
    const localQ     = worldQuat.clone().premultiply(invLinkQ);

    const euler = new THREE.Euler().setFromQuaternion(localQ, 'XYZ');
    col.origin.rpy = { roll: euler.x, pitch: euler.y, yaw: euler.z };
    col.dirty = true;

    const group = Scene.getCollisionGroup(id);
    if (group) {
      group.matrix.copy(collisionWorldMatrix(linkWorldT, col));
      group.matrixWorldNeedsUpdate = true;
    }
    Props.updateValues(col);

  } else if (mode === 'scale' && geometry) {
    // col.geometry is already the drag-end value; baseDims is pre-drag geometry
    if (baseDims) {
      UNDO_STACK.push({
        id: col.id, linkName: S.selLink,
        origin:   JSON.parse(JSON.stringify(col.origin)),
        geometry: JSON.parse(JSON.stringify(baseDims)),
        deleted:  col.deleted
      });
      if (UNDO_STACK.length > UNDO_MAX) UNDO_STACK.shift();
    }
    col.dirty = true;
    _rebuildMesh(id);
    Props.updateValues(col);
    return;
  }

  // Re-attach gizmo after matrix update
  const group = Scene.getCollisionGroup(id);
  if (group) {
    Gizmo.attach(group, col);
    Gizmo.setMode(mode);
  }
}

// ── Save ───────────────────────────────────────────────────────────────────

async function saveURDF() {
  if (!S.filePath || !S.robotData || !S.originalXML) return;
  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = '保存中…';

  try {
    const newXML = buildSaveXML(S.originalXML, S.robotData);
    await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: S.filePath, content: newXML })
    }).then(r => r.json());

    // Update stored original XML + clear dirty flags
    S.originalXML = newXML;
    for (const link of Object.values(S.robotData.links)) {
      for (const col of link.collisions) {
        if (!col.deleted) col.dirty = false;
      }
    }

    flashSaved();
  } catch (err) {
    console.error('Save failed:', err);
    alert('保存失败: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存 URDF';
  }
}

function flashSaved() {
  const el = document.getElementById('save-indicator');
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2500);
}

// ── Top-bar bindings ───────────────────────────────────────────────────────

function bindTopbar() {
  document.getElementById('btn-save').addEventListener('click', saveURDF);

  // Visibility toggles
  document.getElementById('btn-visuals').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    Scene.setVisualsVisible(btn.classList.contains('active'));
  });
  document.getElementById('btn-cols').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    Scene.setCollisionsVisible(btn.classList.contains('active'));
  });
  document.getElementById('btn-axes').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    Scene.setAxesVisible(btn.classList.contains('active'));
  });

  // Gizmo mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      Gizmo.setMode(mode);
    });
  });

  // Keyboard edit axis buttons
  document.querySelectorAll('.axis-btn').forEach(btn => {
    btn.addEventListener('click', () => setEditAxis(btn.dataset.axis));
  });
}

function _currentGizmoMode() {
  const active = document.querySelector('.mode-btn.active');
  return active?.dataset.mode || 'translate';
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────

// Arrow key movement step (meters)
const ARROW_STEP_NORMAL = 0.005;  // 5 mm
const ARROW_STEP_FINE   = 0.001;  // 1 mm  (hold Shift)
const SCALE_STEP_NORMAL = 0.01;   // 1 cm or radius/length equivalent
const SCALE_STEP_FINE   = 0.002;  // 2 mm  (hold Shift)

let EDIT_AXIS = 'x';

function setEditAxis(axis) {
  EDIT_AXIS = axis;
  document.querySelectorAll('.axis-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.axis === axis);
  });
}

function _arrowMove(key, shift, scaleMode) {
  if (!S.selId || !S.selLink) return;
  const col = _getCollision(S.selId);
  if (!col) return;

  if (scaleMode) {
    if (key !== 'ArrowUp' && key !== 'ArrowDown') return;
    const delta = (key === 'ArrowUp' ? 1 : -1) * (shift ? SCALE_STEP_FINE : SCALE_STEP_NORMAL);
    _pushUndoDeduped(col, S.selLink);
    _scaleCollisionOnAxis(col, EDIT_AXIS, delta);
    col.dirty = true;
    _scheduleRebuild(S.selId);
    Props.updateValues(col);
    return;
  }

  const sign = (key === 'ArrowUp' || key === 'ArrowRight') ? 1 : -1;
  const step = sign * (shift ? ARROW_STEP_FINE : ARROW_STEP_NORMAL);

  _pushUndoDeduped(col, S.selLink);
  col.origin.xyz[EDIT_AXIS] += step;
  col.dirty = true;
  _scheduleRebuild(S.selId);
  Props.updateValues(col);
}

function _scaleCollisionOnAxis(col, axis, delta) {
  const g = col.geometry;
  if (g.type === 'box') {
    const key = axis === 'x' ? 'sx' : axis === 'y' ? 'sy' : 'sz';
    g[key] = Math.max(0.001, g[key] + delta);
  } else if (g.type === 'cylinder') {
    // URDF cylinder local Z is length; X/Y affect radius
    if (axis === 'z') g.length = Math.max(0.001, g.length + delta);
    else              g.radius = Math.max(0.001, g.radius + delta * 0.5);
  } else if (g.type === 'sphere') {
    g.radius = Math.max(0.001, g.radius + delta * 0.5);
  }
}

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    // Cmd+Z / Ctrl+Z  →  undo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      _undo();
      return;
    }

    // Don't fire shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    // Arrow keys: edit selected collision body on the selected axis.
    // ↑/→ = positive direction, ↓/← = negative direction.
    // Cmd/Ctrl + ↑/↓ = scale on selected axis.
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      if (S.selId) {
        e.preventDefault();  // prevent page scroll
        _arrowMove(e.key, e.shiftKey, e.metaKey || e.ctrlKey);
      }
      return;
    }

    switch (e.key) {
      case 't': case 'T':
        setGizmoMode('translate'); break;
      case 'r': case 'R':
        setGizmoMode('rotate'); break;
      case 's': case 'S':
        setGizmoMode('scale'); break;
      case 'x': case 'X':
        setEditAxis('x'); break;
      case 'y': case 'Y':
        setEditAxis('y'); break;
      case 'z': case 'Z':
        setEditAxis('z'); break;
      case 'Escape':
        deselect(); break;
      case 'Delete': case 'Backspace':
        if (S.selId) deleteCollision(S.selId); break;
    }
  });
}

function setGizmoMode(mode) {
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  Gizmo.setMode(mode);
}

// ── Loading overlay ────────────────────────────────────────────────────────

function showLoading(text = '加载中…') {
  const ov = document.getElementById('loading-overlay');
  document.getElementById('loading-text').textContent = text;
  ov.classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _getCollision(id) {
  if (!S.robotData) return null;
  for (const link of Object.values(S.robotData.links)) {
    for (const col of link.collisions) {
      if (col.id === id) return col;
    }
  }
  return null;
}

function _findLinkOfCollision(id) {
  if (!S.robotData) return null;
  for (const [linkName, link] of Object.entries(S.robotData.links)) {
    if (link.collisions.some(c => c.id === id)) return linkName;
  }
  return null;
}

// ── Boot ───────────────────────────────────────────────────────────────────

init();
