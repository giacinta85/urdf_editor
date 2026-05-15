/**
 * urdf_parser.js
 * URDF XML → internal data model + Forward Kinematics + save serialization.
 *
 * Data model:
 *   robotData = {
 *     robotName, rootLink,
 *     links:  { [name]: { visuals: [...], collisions: [CollisionObj] } },
 *     joints: { [name]: { type, parent, child, origin } },
 *     jointTree: { [parentLink]: [jointName, ...] }
 *   }
 *
 *   CollisionObj = {
 *     id,            // UUID (stable identity)
 *     origin,        // { xyz:{x,y,z}, rpy:{roll,pitch,yaw} }
 *     geometry,      // { type:'box'|'cylinder'|'sphere', ...params }
 *     originalText,  // exact XML text block from original file (null if new)
 *     dirty,         // true if modified since last save
 *     deleted        // true if marked for removal
 *   }
 */
import * as THREE from 'three';

// ── Helpers ────────────────────────────────────────────────────────────────

let _uidCounter = 0;
function uid() {
  // Use crypto.randomUUID if available, fallback to counter-based
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `col-${Date.now()}-${_uidCounter++}`;
}

function parseVec3(str) {
  if (!str) return { x: 0, y: 0, z: 0 };
  const [x = 0, y = 0, z = 0] = str.trim().split(/\s+/).map(Number);
  return { x, y, z };
}

function parseRPY(str) {
  if (!str) return { roll: 0, pitch: 0, yaw: 0 };
  const [roll = 0, pitch = 0, yaw = 0] = str.trim().split(/\s+/).map(Number);
  return { roll, pitch, yaw };
}

function parseOriginEl(el) {
  const o = el.querySelector(':scope > origin');
  if (!o) return { xyz: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 } };
  return {
    xyz: parseVec3(o.getAttribute('xyz')),
    rpy: parseRPY(o.getAttribute('rpy'))
  };
}

function parseGeomEl(geomEl) {
  if (!geomEl) return { type: 'box', sx: 0.05, sy: 0.05, sz: 0.05 };
  const box = geomEl.querySelector('box');
  if (box) {
    const v = parseVec3(box.getAttribute('size'));
    return { type: 'box', sx: Math.abs(v.x) || 0.05, sy: Math.abs(v.y) || 0.05, sz: Math.abs(v.z) || 0.05 };
  }
  const cyl = geomEl.querySelector('cylinder');
  if (cyl) {
    return {
      type: 'cylinder',
      radius: Math.abs(parseFloat(cyl.getAttribute('radius'))) || 0.04,
      length: Math.abs(parseFloat(cyl.getAttribute('length'))) || 0.1
    };
  }
  const sph = geomEl.querySelector('sphere');
  if (sph) {
    return { type: 'sphere', radius: Math.abs(parseFloat(sph.getAttribute('radius'))) || 0.04 };
  }
  return { type: 'box', sx: 0.05, sy: 0.05, sz: 0.05 };
}

// ── Non-commented collision block extractor ────────────────────────────────

/**
 * Returns array of { start, end, text } for each <collision>…</collision>
 * block that is NOT inside an XML comment.
 */
function extractCollisionBlocks(xmlStr) {
  const blocks = [];
  let pos = 0;
  while (pos < xmlStr.length) {
    const idx = xmlStr.indexOf('<collision', pos);
    if (idx === -1) break;
    if (isInsideComment(xmlStr, idx)) { pos = idx + 1; continue; }
    // Find matching </collision>
    const closeIdx = xmlStr.indexOf('</collision>', idx);
    if (closeIdx === -1) break;
    const end = closeIdx + '</collision>'.length;
    blocks.push({ start: idx, end, text: xmlStr.slice(idx, end) });
    pos = end;
  }
  return blocks;
}

function isInsideComment(xmlStr, pos) {
  let from = 0;
  while (from < pos) {
    const cs = xmlStr.indexOf('<!--', from);
    if (cs === -1 || cs >= pos) break;
    const ce = xmlStr.indexOf('-->', cs + 4);
    if (ce === -1) return true; // unclosed comment → treat as inside
    if (ce + 3 > pos) return true;
    from = ce + 3;
  }
  return false;
}

// ── Mesh path resolver ─────────────────────────────────────────────────────

/**
 * Given the URDF's relative path (from robots/) and a mesh filename
 * (from the XML, e.g. "../meshes/pelvis.STL"), return the URL path to
 * request from Flask /mesh/<path>.
 */
export function resolveMeshUrl(urdfRelPath, meshFilename) {
  const urdfDir = urdfRelPath.split('/').slice(0, -1).join('/');
  const raw = urdfDir ? urdfDir + '/' + meshFilename : meshFilename;
  const parts = raw.split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return '/mesh/' + out.join('/');
}

// ── Main parser ────────────────────────────────────────────────────────────

export function parseURDF(xmlStr) {
  const domParser = new DOMParser();
  const xmlDoc = domParser.parseFromString(xmlStr, 'text/xml');

  const robotEl = xmlDoc.querySelector('robot');
  if (!robotEl) throw new Error('No <robot> element found');
  const robotName = robotEl.getAttribute('name') || 'robot';

  // Pre-extract raw collision blocks (for format-preserving save)
  const collisionBlocks = extractCollisionBlocks(xmlStr);
  let blockIdx = 0;

  const links = {};
  const joints = {};
  const jointTree = {};  // parentLink → [jointName, ...]

  // ── Parse links ──────────────────────────────────────────────────────────
  for (const linkEl of xmlDoc.querySelectorAll('robot > link')) {
    const name = linkEl.getAttribute('name');
    if (!name) continue;

    // Visuals
    const visuals = [];
    for (const visEl of linkEl.querySelectorAll(':scope > visual')) {
      const meshEl = visEl.querySelector('geometry > mesh');
      if (!meshEl) continue;
      visuals.push({
        origin: parseOriginEl(visEl),
        meshFile: meshEl.getAttribute('filename') || ''
      });
    }

    // Active (non-commented) collisions – DOMParser ignores comment nodes
    const collisions = [];
    for (const colEl of linkEl.querySelectorAll(':scope > collision')) {
      const geomEl = colEl.querySelector(':scope > geometry');
      const geometry = parseGeomEl(geomEl);
      const origin   = parseOriginEl(colEl);

      const originalText = blockIdx < collisionBlocks.length
        ? collisionBlocks[blockIdx].text
        : null;
      blockIdx++;

      collisions.push({
        id:           uid(),
        origin,
        geometry,
        originalText, // raw XML text, preserved for surgical save
        dirty:        false,
        deleted:      false
      });
    }

    links[name] = { visuals, collisions };
  }

  // ── Parse joints ─────────────────────────────────────────────────────────
  for (const jointEl of xmlDoc.querySelectorAll('robot > joint')) {
    const name   = jointEl.getAttribute('name');
    const type   = jointEl.getAttribute('type') || 'fixed';
    const parent = jointEl.querySelector(':scope > parent')?.getAttribute('link');
    const child  = jointEl.querySelector(':scope > child')?.getAttribute('link');
    if (!name || !parent || !child) continue;

    joints[name] = { type, parent, child, origin: parseOriginEl(jointEl) };
    if (!jointTree[parent]) jointTree[parent] = [];
    jointTree[parent].push(name);
  }

  // ── Find root link ────────────────────────────────────────────────────────
  const childLinks = new Set(Object.values(joints).map(j => j.child));
  const rootLink = Object.keys(links).find(l => !childLinks.has(l)) || Object.keys(links)[0];

  return { robotName, links, joints, jointTree, rootLink };
}

// ── Forward Kinematics ─────────────────────────────────────────────────────

export function originToMatrix4(origin) {
  const { xyz: { x, y, z }, rpy: { roll, pitch, yaw } } = origin;
  const m = new THREE.Matrix4();
  // URDF RPY = fixed-axis XYZ = Three.js Euler 'XYZ' (roll=x, pitch=y, yaw=z)
  m.makeRotationFromEuler(new THREE.Euler(roll, pitch, yaw, 'XYZ'));
  m.setPosition(x, y, z);
  return m;
}

/** Returns {linkName: THREE.Matrix4} world transforms at zero pose. */
export function computeFK(robotData) {
  const { links, joints, jointTree, rootLink } = robotData;
  const transforms = {};

  function traverse(linkName, parentT) {
    transforms[linkName] = parentT.clone();
    for (const jName of (jointTree[linkName] || [])) {
      const j = joints[jName];
      if (!j) continue;
      const childT = parentT.clone().multiply(originToMatrix4(j.origin));
      traverse(j.child, childT);
    }
  }

  traverse(rootLink, new THREE.Matrix4());
  return transforms;
}

// ── Serialization ──────────────────────────────────────────────────────────

function fmtN(n, decimals = 7) {
  if (!isFinite(n)) return '0';
  return parseFloat(n.toFixed(decimals)).toString();
}

/** Detect leading whitespace of a collision block. */
function detectIndent(colText) {
  const m = colText.match(/^(\s*)/);
  return m ? m[1] : '    ';
}

/** Generate XML text for a collision object. */
export function collisionToXML(col, indent = '    ') {
  const { origin: { xyz, rpy }, geometry } = col;
  const xyzStr = `${fmtN(xyz.x)} ${fmtN(xyz.y)} ${fmtN(xyz.z)}`;
  const rpyStr = `${fmtN(rpy.roll)} ${fmtN(rpy.pitch)} ${fmtN(rpy.yaw)}`;

  let geomLine;
  if (geometry.type === 'box') {
    geomLine = `<box size="${fmtN(geometry.sx)} ${fmtN(geometry.sy)} ${fmtN(geometry.sz)}"/>`;
  } else if (geometry.type === 'cylinder') {
    geomLine = `<cylinder radius="${fmtN(geometry.radius)}" length="${fmtN(geometry.length)}"/>`;
  } else {
    geomLine = `<sphere radius="${fmtN(geometry.radius)}"/>`;
  }

  const i = indent;
  return [
    `${i}<collision>`,
    `${i}  <origin xyz="${xyzStr}" rpy="${rpyStr}" />`,
    `${i}  <geometry>`,
    `${i}    ${geomLine}`,
    `${i}  </geometry>`,
    `${i}</collision>`
  ].join('\n');
}

/**
 * Build save XML via surgical string replacement:
 *  - Modified existing collisions: replace original block text with updated text
 *  - Deleted collisions: remove block text
 *  - New collisions (no originalText): insert before </link>
 *
 * The rest of the file (comments, inertial, visual, joints…) is untouched.
 */
export function buildSaveXML(originalXML, robotData) {
  let result = originalXML;

  for (const [linkName, link] of Object.entries(robotData.links)) {
    // 1. Modify / delete existing collision blocks
    for (const col of link.collisions) {
      if (!col.originalText) continue; // newly added, handled separately

      if (col.deleted) {
        // Remove block + preceding newline (keeps file tidy)
        const withNL = '\n' + col.originalText;
        if (result.includes(withNL)) {
          result = result.replace(withNL, '');
        } else {
          result = result.replace(col.originalText, '');
        }
      } else if (col.dirty) {
        const indent = detectIndent(col.originalText);
        const newText = collisionToXML(col, indent);
        result = result.replace(col.originalText, newText);
        // Update stored text so subsequent saves use the new version
        col.originalText = newText;
      }
    }

    // 2. Insert newly added collisions before this link's </link> closing tag
    const newCols = link.collisions.filter(c => !c.originalText && !c.deleted);
    if (newCols.length === 0) continue;

    // Find the <link name="..."> tag to get the correct </link>
    const linkTagRe = new RegExp(`<link\\s+name="${linkName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`);
    const linkTagMatch = linkTagRe.exec(result);
    if (!linkTagMatch) continue;

    const linkStart = linkTagMatch.index;
    const linkCloseIdx = result.indexOf('</link>', linkStart);
    if (linkCloseIdx === -1) continue;

    const insertText = newCols.map(c => '\n' + collisionToXML(c, '    ')).join('');
    result = result.slice(0, linkCloseIdx) + insertText + '\n  ' + result.slice(linkCloseIdx);

    // Give the new collisions an originalText so future saves treat them as existing
    const insertBlocks = extractCollisionBlocks(insertText + '\n');
    newCols.forEach((c, i) => {
      if (insertBlocks[i]) c.originalText = insertBlocks[i].text;
    });
  }

  return result;
}

// ── Default collision factory ──────────────────────────────────────────────

export function createDefaultCollision(type = 'box') {
  const geometry = type === 'cylinder'
    ? { type: 'cylinder', radius: 0.04, length: 0.08 }
    : type === 'sphere'
    ? { type: 'sphere', radius: 0.04 }
    : { type: 'box', sx: 0.06, sy: 0.06, sz: 0.06 };

  return {
    id:           uid(),
    origin:       { xyz: { x: 0, y: 0, z: 0 }, rpy: { roll: 0, pitch: 0, yaw: 0 } },
    geometry,
    originalText: null,
    dirty:        true,
    deleted:      false
  };
}
