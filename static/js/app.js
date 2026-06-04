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
let MAGNET_ENABLED = false;
const SETTINGS_KEY = 'urdfEditorSettings.v1';

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSetting(key, value) {
  const settings = loadSettings();
  settings[key] = value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

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
  onMirror:         mirrorCollision,
  onMirrorLink:     mirrorLinkCollisions,
  onDelete:         deleteCollision
});

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  await fetchFileList();
  bindTopbar();
  bindSceneCreatePopup();
  bindKeyboard();
  Scene.onCollisionClick((id, linkName) => {
    if (id) selectCollision(id, linkName);
    else    deselect();
  });
  Scene.onCreateCollisionRequest(showSceneCreatePopup);
  Scene.onAxisViewExit(() => {
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
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

function addCollision(linkName, type, worldPoint = null) {
  if (!S.robotData) return;
  const col = createDefaultCollision(type);
  if (worldPoint && S.fkT[linkName]) {
    const localPoint = worldPoint.clone().applyMatrix4(S.fkT[linkName].clone().invert());
    col.origin.xyz = { x: localPoint.x, y: localPoint.y, z: localPoint.z };
  }
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

function mirrorCollision(id) {
  if (!S.robotData) return;
  const srcCol = _getCollision(id);
  const srcLinkName = _findLinkOfCollision(id);
  if (!srcCol || !srcLinkName) return;

  const dstLinkName = _pairedLinkName(srcLinkName, S.robotData.links);
  if (!dstLinkName) {
    alert(`未找到 ${srcLinkName} 的对侧 link`);
    return;
  }

  const srcIndex = _activeCollisionIndex(S.robotData.links[srcLinkName], id);
  if (srcIndex < 0) return;

  _mirrorCollisionToIndex(srcCol, dstLinkName, srcIndex);

  Tree.render(S.robotData, S.selId);
  Tree.setSelected(S.selId);
}

function mirrorLinkCollisions(id) {
  if (!S.robotData) return;
  const srcLinkName = _findLinkOfCollision(id);
  if (!srcLinkName) return;

  const dstLinkName = _pairedLinkName(srcLinkName, S.robotData.links);
  if (!dstLinkName) {
    alert(`未找到 ${srcLinkName} 的对侧 link`);
    return;
  }

  const srcActive = S.robotData.links[srcLinkName].collisions.filter(c => !c.deleted);
  srcActive.forEach((col, idx) => _mirrorCollisionToIndex(col, dstLinkName, idx));

  Tree.render(S.robotData, S.selId);
  Tree.setSelected(S.selId);
}

function _mirrorCollisionToIndex(srcCol, dstLinkName, dstIndex) {
  const dstLink = S.robotData.links[dstLinkName];
  const dstActive = dstLink.collisions.filter(c => !c.deleted);
  const mirrored = _mirroredCollisionData(srcCol);
  let dstCol = dstActive[dstIndex] || null;

  if (dstCol) {
    _pushUndo(dstCol, dstLinkName);
    dstCol.origin = mirrored.origin;
    dstCol.geometry = mirrored.geometry;
    dstCol.dirty = true;
    Scene.updateCollisionMesh(dstCol, S.fkT[dstLinkName]);
    return dstCol;
  }

  dstCol = createDefaultCollision(srcCol.geometry.type);
  dstCol.origin = mirrored.origin;
  dstCol.geometry = mirrored.geometry;
  dstCol.dirty = true;
  dstLink.collisions.push(dstCol);
  _pushUndo(dstCol, dstLinkName, true);
  Scene.addCollisionMesh(dstLinkName, dstCol, S.fkT[dstLinkName]);
  return dstCol;
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
    _applyMagnetSnap(id, linkWorldT, S.selLink);
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
  const settings = loadSettings();
  document.getElementById('btn-save').addEventListener('click', saveURDF);

  // Visibility toggles
  const btnVisuals = document.getElementById('btn-visuals');
  const btnCols = document.getElementById('btn-cols');
  const btnAxes = document.getElementById('btn-axes');
  const btnMagnet = document.getElementById('btn-magnet');
  const opacityInput = document.getElementById('visual-opacity');
  const opacityValue = document.getElementById('visual-opacity-value');
  const collisionColorInput = document.getElementById('collision-color');

  if (settings.visualsVisible !== undefined) {
    btnVisuals.classList.toggle('active', settings.visualsVisible);
    Scene.setVisualsVisible(settings.visualsVisible);
  }
  if (settings.collisionsVisible !== undefined) {
    btnCols.classList.toggle('active', settings.collisionsVisible);
    Scene.setCollisionsVisible(settings.collisionsVisible);
  }
  if (settings.axesVisible !== undefined) {
    btnAxes.classList.toggle('active', settings.axesVisible);
    Scene.setAxesVisible(settings.axesVisible);
  }
  if (settings.magnetEnabled !== undefined) {
    MAGNET_ENABLED = settings.magnetEnabled;
    btnMagnet.classList.toggle('active', MAGNET_ENABLED);
  }
  if (settings.visualOpacity !== undefined) {
    const pct = Math.round(settings.visualOpacity * 100);
    opacityInput.value = String(pct);
    opacityValue.textContent = `${pct}%`;
    Scene.setVisualOpacity(settings.visualOpacity);
  }
  if (settings.collisionColor) {
    collisionColorInput.value = settings.collisionColor;
    Scene.setCollisionColor(settings.collisionColor);
  }

  btnVisuals.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    const active = btn.classList.contains('active');
    Scene.setVisualsVisible(active);
    saveSetting('visualsVisible', active);
  });
  btnCols.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    const active = btn.classList.contains('active');
    Scene.setCollisionsVisible(active);
    saveSetting('collisionsVisible', active);
  });
  collisionColorInput.addEventListener('input', (e) => {
    const color = e.currentTarget.value;
    Scene.setCollisionColor(color);
    saveSetting('collisionColor', color);
  });
  btnAxes.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    const active = btn.classList.contains('active');
    Scene.setAxesVisible(active);
    saveSetting('axesVisible', active);
  });

  btnMagnet.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    MAGNET_ENABLED = btn.classList.contains('active');
    saveSetting('magnetEnabled', MAGNET_ENABLED);
  });

  opacityInput.addEventListener('input', () => {
    const pct = parseInt(opacityInput.value, 10);
    opacityValue.textContent = `${pct}%`;
    const opacity = pct / 100;
    Scene.setVisualOpacity(opacity);
    saveSetting('visualOpacity', opacity);
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

  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Scene.setViewAxis(btn.dataset.view);
    });
  });
}

let _pendingSceneCreate = null;

function bindSceneCreatePopup() {
  const popup = document.getElementById('add-popup');
  popup.querySelectorAll('.add-popup-item').forEach(item => {
    item.addEventListener('click', () => {
      if (!_pendingSceneCreate) return;
      addCollision(_pendingSceneCreate.linkName, item.dataset.type, _pendingSceneCreate.worldPoint);
      _pendingSceneCreate = null;
    });
  });

  document.addEventListener('pointerdown', (e) => {
    if (!popup.contains(e.target)) _pendingSceneCreate = null;
  });
}

function showSceneCreatePopup({ linkName, worldPoint, clientX, clientY }) {
  const targetLink = linkName || S.selLink;
  if (!S.robotData || !targetLink || !S.robotData.links[targetLink]) {
    alert('请先在机器人或已有碰撞体上右键，或先选中一个 link/碰撞体');
    return;
  }

  _pendingSceneCreate = { linkName: targetLink, worldPoint };
  const popup = document.getElementById('add-popup');
  popup.style.display = 'block';
  popup.style.left = clientX + 'px';
  popup.style.top = clientY + 'px';
}

function _currentGizmoMode() {
  const active = document.querySelector('.mode-btn.active');
  return active?.dataset.mode || 'translate';
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────

// Arrow key movement step (meters)
const ARROW_STEP_NORMAL = 0.0001;
const ARROW_STEP_FINE   = 0.00001; // hold Shift for finer edits
const SCALE_STEP_NORMAL = 0.0001;
const SCALE_STEP_FINE   = 0.00001; // hold Shift for finer edits

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

  const step = shift ? ARROW_STEP_FINE : ARROW_STEP_NORMAL;
  const deltaByKey = {
    ArrowUp:    { axis: 'x', delta:  step },
    ArrowDown:  { axis: 'x', delta: -step },
    ArrowLeft:  { axis: 'y', delta:  step },
    ArrowRight: { axis: 'y', delta: -step }
  };
  const move = deltaByKey[key];
  if (!move) return;

  _pushUndoDeduped(col, S.selLink);
  col.origin.xyz[move.axis] += move.delta;
  col.dirty = true;
  _rebuildMesh(S.selId);
  _applyMagnetSnap(S.selId, S.fkT[S.selLink], S.selLink);
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
    else              g.radius = Math.max(0.001, g.radius + delta);
  } else if (g.type === 'sphere') {
    g.radius = Math.max(0.001, g.radius + delta);
  }
}

function _applyMagnetSnap(id, linkWorldT, linkName) {
  if (!MAGNET_ENABLED) return false;
  const delta = Scene.getMagnetSnapDelta(id, linkName);
  if (!delta || delta.lengthSq() === 0) return false;

  const col = _getCollision(id);
  const group = Scene.getCollisionGroup(id);
  if (!col || !group) return false;

  group.updateMatrixWorld(true);
  const worldPos = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld).add(delta);
  const localPos = worldPos.applyMatrix4(linkWorldT.clone().invert());
  col.origin.xyz = { x: localPos.x, y: localPos.y, z: localPos.z };
  col.dirty = true;

  group.matrix.copy(collisionWorldMatrix(linkWorldT, col));
  group.matrixWorldNeedsUpdate = true;
  return true;
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

    // Arrow keys: edit selected collision body.
    // Translate mode: ↑/↓ forward-back (X), ←/→ left-right (Y).
    // Scale mode or Cmd/Ctrl + ↑/↓: resize on selected axis.
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      if (S.selId) {
        e.preventDefault();  // prevent page scroll
        _arrowMove(e.key, e.shiftKey, _currentGizmoMode() === 'scale' || e.metaKey || e.ctrlKey);
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

function _activeCollisionIndex(link, id) {
  return link.collisions.filter(c => !c.deleted).findIndex(c => c.id === id);
}

function _pairedLinkName(linkName, links) {
  const pairs = [
    [/^left_/, 'right_'],
    [/^right_/, 'left_'],
    [/_left_/, '_right_'],
    [/_right_/, '_left_'],
    [/_left$/, '_right'],
    [/_right$/, '_left'],
    [/^Left_/, 'Right_'],
    [/^Right_/, 'Left_'],
    [/^L_/, 'R_'],
    [/^R_/, 'L_']
  ];

  for (const [pattern, replacement] of pairs) {
    if (!pattern.test(linkName)) continue;
    const candidate = linkName.replace(pattern, replacement);
    if (links[candidate]) return candidate;
  }
  return null;
}

function _mirroredCollisionData(col) {
  return {
    origin: {
      xyz: {
        x: col.origin.xyz.x,
        y: -col.origin.xyz.y,
        z: col.origin.xyz.z
      },
      rpy: { ...col.origin.rpy }
    },
    geometry: { ...col.geometry }
  };
}

// ── Boot ───────────────────────────────────────────────────────────────────

init();
