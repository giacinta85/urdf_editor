/**
 * scene.js
 * Three.js scene management: renderer, camera, lights, STL meshes, collision meshes.
 */
import * as THREE from 'three';
import { OrbitControls }  from 'three/addons/controls/OrbitControls.js';
import { STLLoader }      from 'three/addons/loaders/STLLoader.js';
import { originToMatrix4 } from './urdf_parser.js';

const DEFAULT_COLLISION_COLOR = 0xffd400;
const SELECTED_HIGHLIGHT_COLOR = 0x00d4ff;
const SELECTED_EMISSIVE_COLOR = 0x004455;
const COLLISION_OPACITY = 0.34;
const COLLISION_WIRE_OPACITY = 0.08;
const SELECTED_COLLISION_OPACITY = 0.58;
const SELECTED_WIRE_OPACITY = 0.35;

// ── Build Three.js geometry from collision data ────────────────────────────

/**
 * Create a collision body mesh (solid + wireframe overlay).
 * Returns { group, solidMesh, wireMesh } — group is the scene object.
 * The group's matrix is NOT auto-updated (we set matrixAutoUpdate=false and
 * call group.matrix.copy(worldTransform) from outside).
 */
export function buildCollisionMesh(col, color) {
  const { geometry } = col;
  let geom;
  if (geometry.type === 'box') {
    geom = new THREE.BoxGeometry(geometry.sx, geometry.sy, geometry.sz);
  } else if (geometry.type === 'cylinder') {
    // URDF cylinder axis = Z, Three.js CylinderGeometry axis = Y
    // Bake 90° X-rotation into the geometry so world-space transforms work correctly
    geom = new THREE.CylinderGeometry(geometry.radius, geometry.radius, geometry.length, 32, 1, false);
    geom.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  } else {
    geom = new THREE.SphereGeometry(geometry.radius, 24, 16);
  }

  const solidMat = new THREE.MeshPhongMaterial({
    color,
    transparent: true,
    opacity: COLLISION_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const wireMat = new THREE.MeshBasicMaterial({
    color,
    wireframe: true,
    transparent: true,
    opacity: COLLISION_WIRE_OPACITY
  });

  const solidMesh = new THREE.Mesh(geom, solidMat);
  const wireMesh  = new THREE.Mesh(geom, wireMat);

  const group = new THREE.Group();
  group.add(solidMesh, wireMesh);
  group.matrixAutoUpdate = false;
  return { group, solidMesh, wireMesh, geom };
}

/**
 * Compute world matrix for a collision body:
 *   world_T = linkWorldT × collisionOriginT
 */
export function collisionWorldMatrix(linkWorldT, col) {
  const colT = originToMatrix4(col.origin);
  return linkWorldT.clone().multiply(colT);
}

// ── Main Scene class ───────────────────────────────────────────────────────

export class URDFScene {
  constructor(canvas) {
    this._canvas  = canvas;
    this._objects = {};        // uuid → {group, solidMesh, wireMesh}
    this._stlMeshes = {};      // linkName → THREE.Mesh[]
    this._selectedId = null;
    this._showVisuals    = true;
    this._showCollisions = true;
    this._showAxes       = true;
    this._visualOpacity  = 0.35;
    this._collisionColor = DEFAULT_COLLISION_COLOR;
    this._axesHelpers    = [];
    this._onClickCb      = null;
    this._onCreateCb     = null;
    this._onViewExitCb   = null;
    this._linkWorldTs    = {};  // linkName → Matrix4
    this._axisViewActive = false;

    this._init();
  }

  _init() {
    const w = this._canvas.clientWidth;
    const h = this._canvas.clientHeight;

    // Renderer
    this._renderer = new THREE.WebGLRenderer({
      canvas:    this._canvas,
      antialias: true,
      alpha:     true
    });
    this._renderer.setSize(w, h);
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.shadowMap.enabled = true;

    // Scene
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x111316);
    this._scene.fog = new THREE.Fog(0x111316, 6, 20);

    // Camera — URDF uses Z-up, so set camera.up to Z
    this._camera = new THREE.PerspectiveCamera(50, w / h, 0.001, 100);
    this._camera.up.set(0, 0, 1);
    // Front-diagonal view: camera is in front (−Y) and to the side (+X), slightly elevated
    this._camera.position.set(1.5, -2.0, 1.2);
    this._camera.lookAt(0, 0, 0.5);

    // Orbit controls
    this._orbit = new OrbitControls(this._camera, this._canvas);
    this._orbit.object.up.set(0, 0, 1);
    this._orbit.enableDamping = true;
    this._orbit.dampingFactor = 0.08;
    this._orbit.minDistance   = 0.05;
    this._orbit.maxDistance   = 8;
    this._orbit.addEventListener('start', () => this._exitAxisView());

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this._scene.add(ambient);

    const dirA = new THREE.DirectionalLight(0xffffff, 1.0);
    dirA.position.set(2, 4, 3);
    this._scene.add(dirA);

    const dirB = new THREE.DirectionalLight(0xc9d3df, 0.35);
    dirB.position.set(-2, -1, -2);
    this._scene.add(dirB);

    // Grid — lies on XY plane at Z=0 (robot stands on this plane)
    const grid = new THREE.GridHelper(4, 40, 0x343a42, 0x242930);
    // GridHelper is horizontal (XZ plane); rotate so it lies on XY plane for Z-up
    grid.rotation.x = Math.PI / 2;
    grid.position.z = 0;
    this._scene.add(grid);
    this._grid = grid;

    // Raycaster
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // Click handler
    this._canvas.addEventListener('pointerdown', this._onPointerDown.bind(this));
    this._canvas.addEventListener('pointerup', this._onPointerUp.bind(this));
    this._canvas.addEventListener('contextmenu', this._onContextMenu.bind(this));

    // Resize
    new ResizeObserver(() => this._onResize()).observe(this._canvas.parentElement);

    // Render loop
    this._animate();
  }

  get renderer()  { return this._renderer; }
  get camera()    { return this._camera;   }
  get scene()     { return this._scene;    }
  get orbit()     { return this._orbit;    }

  onCollisionClick(cb) { this._onClickCb = cb; }
  onCreateCollisionRequest(cb) { this._onCreateCb = cb; }
  onAxisViewExit(cb) { this._onViewExitCb = cb; }

  // ── Load full robot ──────────────────────────────────────────────────────

  clearRobot() {
    // Remove STL meshes
    for (const meshes of Object.values(this._stlMeshes)) {
      for (const m of meshes) this._scene.remove(m);
    }
    this._stlMeshes = {};

    // Remove collision objects
    for (const { group } of Object.values(this._objects)) {
      this._scene.remove(group);
    }
    this._objects = {};

    // Remove axes
    for (const a of this._axesHelpers) this._scene.remove(a);
    this._axesHelpers = [];

    this._selectedId  = null;
    this._linkWorldTs = {};
    if (this._grid) this._grid.position.z = 0;
  }

  /**
   * Load robot: STL meshes + collision bodies.
   * @param {object}  robotData    - from parseURDF()
   * @param {object}  fkTransforms - from computeFK()
   * @param {string}  urdfRelPath  - for resolving mesh URLs
   * @param {function} resolveMeshUrl - from urdf_parser
   */
  async loadRobot(robotData, fkTransforms, urdfRelPath, resolveMeshUrl) {
    this.clearRobot();
    this._linkWorldTs = fkTransforms;
    const loader = new STLLoader();

    const loadSTL = (url) => new Promise((resolve) => {
      loader.load(url,
        (geom) => resolve(geom),
        undefined,
        ()    => resolve(null)   // silently ignore missing STLs
      );
    });

    for (const [linkName, link] of Object.entries(robotData.links)) {
      const linkT = fkTransforms[linkName];
      if (!linkT) continue;

      // ── STL visuals ────────────────────────────────────────────────────
      for (const vis of link.visuals) {
        if (!vis.meshFile) continue;
        const url  = resolveMeshUrl(urdfRelPath, vis.meshFile);
        const geom = await loadSTL(url);
        if (!geom) continue;

        geom.computeVertexNormals();
        const mat  = new THREE.MeshPhongMaterial({
          color:       0xc3c8ce,
          transparent: true,
          opacity:     this._visualOpacity,
          depthWrite:  this._visualOpacity >= 1,
          side:        THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geom, mat);

        // Apply link world transform + visual origin transform
        const visOriginT = originToMatrix4(vis.origin);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(linkT.clone().multiply(visOriginT));
        mesh.matrixWorldNeedsUpdate = true;
        mesh.visible = this._showVisuals;
        mesh.userData.linkName = linkName;
        mesh.userData.isVisual = true;

        this._scene.add(mesh);
        if (!this._stlMeshes[linkName]) this._stlMeshes[linkName] = [];
        this._stlMeshes[linkName].push(mesh);
      }

      // ── Collision bodies ───────────────────────────────────────────────
      for (const col of link.collisions) {
        if (col.deleted) continue;
        this.addCollisionMesh(linkName, col, linkT);
      }

      // ── Joint axes ─────────────────────────────────────────────────────
      const axes = new THREE.AxesHelper(0.04);
      axes.matrixAutoUpdate = false;
      axes.matrix.copy(linkT);
      axes.matrixWorldNeedsUpdate = true;
      axes.visible = this._showAxes;
      this._scene.add(axes);
      this._axesHelpers.push(axes);
    }

    const bounds = this._computeRobotBounds(false);
    this._updateGroundPlane(bounds);

    // Auto-fit camera
    this._fitCamera();
  }

  // ── Collision mesh management ────────────────────────────────────────────

  addCollisionMesh(linkName, col, linkWorldT) {
    const color = this._collisionColor;
    const { group, solidMesh, wireMesh } = buildCollisionMesh(col, color);
    group.matrix.copy(collisionWorldMatrix(linkWorldT, col));
    group.matrixWorldNeedsUpdate = true;
    group.visible = this._showCollisions;

    // Tag for raycasting
    solidMesh.userData.collisionId = col.id;
    solidMesh.userData.linkName    = linkName;
    wireMesh.userData.collisionId  = col.id;
    wireMesh.userData.linkName     = linkName;

    this._scene.add(group);
    this._objects[col.id] = { group, solidMesh, wireMesh };
    return group;
  }

  /**
   * Rebuild a collision mesh after geometry/origin change.
   * Returns the (updated) group.
   */
  updateCollisionMesh(col, linkWorldT) {
    const existing = this._objects[col.id];
    if (!existing) return null;

    const isSelected = this._selectedId === col.id;
    const color = this._collisionColor;

    // Remove old group
    const linkName = existing.solidMesh.userData.linkName;
    this._scene.remove(existing.group);

    // Build new
    const { group, solidMesh, wireMesh } = buildCollisionMesh(col, color);
    group.matrix.copy(collisionWorldMatrix(linkWorldT, col));
    group.matrixWorldNeedsUpdate = true;
    group.visible = this._showCollisions;

    solidMesh.userData.collisionId = col.id;
    solidMesh.userData.linkName    = linkName;
    wireMesh.userData.collisionId  = col.id;
    wireMesh.userData.linkName     = linkName;

    if (isSelected) {
      solidMesh.material.emissive = new THREE.Color(SELECTED_EMISSIVE_COLOR);
      solidMesh.material.opacity = SELECTED_COLLISION_OPACITY;
      wireMesh.material.color.setHex(SELECTED_HIGHLIGHT_COLOR);
      wireMesh.material.opacity = SELECTED_WIRE_OPACITY;
    }

    this._scene.add(group);
    this._objects[col.id] = { group, solidMesh, wireMesh };
    return group;
  }

  removeCollisionMesh(id) {
    const obj = this._objects[id];
    if (!obj) return;
    this._scene.remove(obj.group);
    delete this._objects[id];
    if (this._selectedId === id) this._selectedId = null;
  }

  /** Get the Three.js group for a collision (for attaching gizmo). */
  getCollisionGroup(id) {
    return this._objects[id]?.group || null;
  }

  // ── Selection ────────────────────────────────────────────────────────────

  selectCollision(id) {
    this._deselectCurrent();
    this._selectedId = id;

    const obj = this._objects[id];
    if (!obj) return;
    obj.solidMesh.material.emissive = new THREE.Color(SELECTED_EMISSIVE_COLOR);
    obj.solidMesh.material.color.setHex(this._collisionColor);
    obj.solidMesh.material.opacity = SELECTED_COLLISION_OPACITY;
    obj.wireMesh.material.color.setHex(SELECTED_HIGHLIGHT_COLOR);
    obj.wireMesh.material.opacity = SELECTED_WIRE_OPACITY;
  }

  deselectCollision() {
    this._deselectCurrent();
    this._selectedId = null;
  }

  _deselectCurrent() {
    if (!this._selectedId) return;
    const obj = this._objects[this._selectedId];
    if (!obj) return;
    obj.solidMesh.material.emissive = new THREE.Color(0x000000);
    obj.solidMesh.material.color.setHex(this._collisionColor);
    obj.solidMesh.material.opacity = COLLISION_OPACITY;
    obj.wireMesh.material.color.setHex(this._collisionColor);
    obj.wireMesh.material.opacity = COLLISION_WIRE_OPACITY;
  }

  // ── Visibility toggles ───────────────────────────────────────────────────

  setVisualsVisible(v) {
    this._showVisuals = v;
    for (const meshes of Object.values(this._stlMeshes)) {
      for (const m of meshes) m.visible = v;
    }
  }

  setVisualOpacity(opacity) {
    this._visualOpacity = Math.max(0.05, Math.min(1, opacity));
    for (const meshes of Object.values(this._stlMeshes)) {
      for (const m of meshes) {
        m.material.opacity = this._visualOpacity;
        m.material.transparent = this._visualOpacity < 1;
        m.material.depthWrite = this._visualOpacity >= 1;
        m.material.needsUpdate = true;
      }
    }
  }

  setCollisionsVisible(v) {
    this._showCollisions = v;
    for (const { group } of Object.values(this._objects)) {
      group.visible = v;
    }
  }

  setCollisionColor(color) {
    this._collisionColor = new THREE.Color(color).getHex();
    for (const [id, obj] of Object.entries(this._objects)) {
      obj.solidMesh.material.color.setHex(this._collisionColor);
      obj.wireMesh.material.color.setHex(this._collisionColor);
      if (id === this._selectedId) {
        obj.solidMesh.material.emissive = new THREE.Color(SELECTED_EMISSIVE_COLOR);
        obj.solidMesh.material.opacity = SELECTED_COLLISION_OPACITY;
        obj.wireMesh.material.color.setHex(SELECTED_HIGHLIGHT_COLOR);
        obj.wireMesh.material.opacity = SELECTED_WIRE_OPACITY;
      } else {
        obj.solidMesh.material.emissive = new THREE.Color(0x000000);
        obj.solidMesh.material.opacity = COLLISION_OPACITY;
        obj.wireMesh.material.opacity = COLLISION_WIRE_OPACITY;
      }
      obj.solidMesh.material.needsUpdate = true;
      obj.wireMesh.material.needsUpdate = true;
    }
  }

  setAxesVisible(v) {
    this._showAxes = v;
    for (const a of this._axesHelpers) a.visible = v;
  }

  setViewAxis(axis) {
    const box = this._selectedBounds() || this._computeRobotBounds(true);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const dist = Math.max(Math.max(size.x, size.y, size.z) * 3, 0.25);

    if (axis === 'x') {
      this._camera.up.set(0, 0, 1);
      this._camera.position.set(center.x + dist, center.y, center.z);
    } else if (axis === 'y') {
      this._camera.up.set(0, 0, 1);
      this._camera.position.set(center.x, center.y - dist, center.z);
    } else {
      this._camera.up.set(0, 1, 0);
      this._camera.position.set(center.x, center.y, center.z + dist);
    }
    this._orbit.object.up.copy(this._camera.up);
    this._orbit.target.copy(center);
    this._camera.lookAt(center);
    this._orbit.update();
    this._axisViewActive = true;
  }

  _exitAxisView() {
    if (!this._axisViewActive) return;
    this._axisViewActive = false;
    this._camera.up.set(0, 0, 1);
    this._orbit.object.up.copy(this._camera.up);
    if (this._onViewExitCb) this._onViewExitCb();
  }

  _selectedBounds() {
    if (!this._selectedId) return null;
    const obj = this._objects[this._selectedId];
    if (!obj) return null;
    obj.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj.group);
    return box.isEmpty() ? null : box;
  }

  getMagnetSnapDelta(id, linkName = null, threshold = 0.1) {
    const obj = this._objects[id];
    if (!obj) return null;

    let robotBox = this._computeVisualBounds(linkName);
    if (robotBox.isEmpty() && linkName) robotBox = this._computeVisualBounds();
    if (robotBox.isEmpty()) return null;

    obj.group.updateMatrixWorld(true);
    const colBox = new THREE.Box3().setFromObject(obj.group);
    if (colBox.isEmpty()) return null;

    const axes = ['x', 'y', 'z'];
    let best = null;
    for (const axis of axes) {
      const deltas = [
        robotBox.min[axis] - colBox.max[axis],
        robotBox.max[axis] - colBox.min[axis]
      ];
      for (const d of deltas) {
        const dist = Math.abs(d);
        if (dist > threshold) continue;
        if (!best || dist < best.dist) best = { axis, delta: d, dist };
      }
    }
    if (!best) return null;

    const delta = new THREE.Vector3();
    delta[best.axis] = best.delta;
    return delta;
  }

  // ── Camera helpers ────────────────────────────────────────────────────────

  _fitCamera() {
    // Compute bounding box — prefer STL meshes for tighter fit, fall back to collision bodies
    const box = this._computeRobotBounds(true);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist   = maxDim * 1.8;

    // Z-up: place camera in front-diagonal position, look at robot center
    this._camera.position.set(
      center.x + dist * 0.45,
      center.y - dist,
      center.z + dist * 0.25
    );
    this._orbit.target.copy(center);
    this._orbit.update();
  }

  _computeRobotBounds(preferVisuals) {
    const box = new THREE.Box3();
    for (const meshes of Object.values(this._stlMeshes)) {
      for (const m of meshes) {
        m.updateMatrixWorld(true);
        box.expandByObject(m);
      }
    }
    if (!preferVisuals || box.isEmpty()) {
      for (const { group } of Object.values(this._objects)) {
        group.updateMatrixWorld(true);
        box.expandByObject(group);
      }
    }
    return box;
  }

  _computeVisualBounds(linkName = null) {
    const box = new THREE.Box3();
    const meshGroups = linkName ? [this._stlMeshes[linkName] || []] : Object.values(this._stlMeshes);
    for (const meshes of meshGroups) {
      for (const m of meshes) {
        m.updateMatrixWorld(true);
        box.expandByObject(m);
      }
    }
    return box;
  }

  _updateGroundPlane(box) {
    if (!this._grid || box.isEmpty()) return;
    this._grid.position.z = box.min.z;
  }

  focusOnLink(linkName) {
    const worldT = this._linkWorldTs[linkName];
    if (!worldT) return;
    const pos = new THREE.Vector3().setFromMatrixPosition(worldT);
    this._smoothFocusTo(pos, 0.5);
  }

  focusOnCollision(id) {
    const obj = this._objects[id];
    if (!obj) return;
    const pos = new THREE.Vector3();
    obj.group.updateMatrixWorld(true);
    pos.setFromMatrixPosition(obj.group.matrixWorld);
    this._centerViewOn(pos);
  }

  _centerViewOn(targetPos) {
    const camOffset = this._camera.position.clone().sub(this._orbit.target);
    this._orbit.target.copy(targetPos);
    this._camera.position.copy(targetPos).add(camOffset);
    this._orbit.update();
  }

  _smoothFocusTo(targetPos, shrinkFactor) {
    const camOffset = this._camera.position.clone().sub(this._orbit.target);
    const dist = Math.max(camOffset.length() * shrinkFactor, 0.3);
    this._orbit.target.copy(targetPos);
    this._camera.position.copy(targetPos).add(camOffset.normalize().multiplyScalar(dist));
    this._orbit.update();
  }

  // ── Raycasting ────────────────────────────────────────────────────────────

  _onPointerDown(e) {
    if (e.button !== 0) return;
    this._pointerDown = { x: e.clientX, y: e.clientY };
  }

  _onPointerUp(e) {
    if (e.button !== 0 || !this._pointerDown) return;
    const dx = e.clientX - this._pointerDown.x;
    const dy = e.clientY - this._pointerDown.y;
    this._pointerDown = null;
    if (Math.hypot(dx, dy) > 4) return;

    const rect = this._canvas.getBoundingClientRect();
    this._mouse.x = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    this._mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    this._pendingClick = true;
  }

  _onContextMenu(e) {
    e.preventDefault();
    const hit = this._raycastAt(e, true);
    if (!this._onCreateCb) return;
    this._onCreateCb({
      linkName: hit?.object.userData.linkName || null,
      worldPoint: hit?.point || null,
      clientX: e.clientX,
      clientY: e.clientY
    });
  }

  _checkRaycast() {
    if (!this._pendingClick) return;
    this._pendingClick = false;
    if (!this._showCollisions) return;

    const hits = this._raycastCollisions();
    if (hits.length > 0 && this._onClickCb) {
      const { collisionId, linkName } = hits[0].object.userData;
      this._onClickCb(collisionId, linkName);
    }
  }

  _raycastCollisions() {
    this._raycaster.setFromCamera(this._mouse, this._camera);
    const meshes = Object.values(this._objects)
      .filter(o => o.group.visible)
      .map(o => o.solidMesh);
    return this._raycaster.intersectObjects(meshes, false);
  }

  _raycastAt(e, includeVisuals) {
    const rect = this._canvas.getBoundingClientRect();
    this._mouse.x = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    this._mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this._camera);

    const objects = Object.values(this._objects)
      .filter(o => o.group.visible)
      .map(o => o.solidMesh);
    if (includeVisuals) {
      for (const meshes of Object.values(this._stlMeshes)) {
        for (const m of meshes) {
          if (m.visible) objects.push(m);
        }
      }
    }

    return this._raycaster.intersectObjects(objects, false)[0] || null;
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  _animate() {
    requestAnimationFrame(this._animate.bind(this));
    this._orbit.update();
    this._checkRaycast();
    this._renderer.render(this._scene, this._camera);
  }

  _onResize() {
    const wrap = this._canvas.parentElement;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(w, h);
  }
}
