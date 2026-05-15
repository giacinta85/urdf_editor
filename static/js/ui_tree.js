/**
 * ui_tree.js
 * Left-panel link/collision tree.
 */

const GEOM_ICONS = { box: '📦', cylinder: '⬭', sphere: '⬤' };

export class LinkTree {
  /**
   * @param {HTMLElement} container
   * @param {object}      callbacks
   *   onSelectCollision(id, linkName)
   *   onDeleteCollision(id)
   *   onAddCollision(linkName, type)
   *   onFocusLink(linkName)
   */
  constructor(container, callbacks) {
    this._el  = container;
    this._cb  = callbacks;
    this._open = {};       // linkName → boolean (expanded)
    this._addPopup = document.getElementById('add-popup');
    this._pendingAddLink = null;

    // Close popup on outside click
    document.addEventListener('pointerdown', (e) => {
      if (!this._addPopup.contains(e.target)) this._hidePopup();
    });
    this._addPopup.querySelectorAll('.add-popup-item').forEach(item => {
      item.addEventListener('click', () => {
        if (this._pendingAddLink) {
          this._cb.onAddCollision(this._pendingAddLink, item.dataset.type);
        }
        this._hidePopup();
      });
    });
  }

  render(robotData, selectedId) {
    if (!robotData) { this._el.innerHTML = ''; return; }
    const { links, joints, rootLink } = robotData;

    // Build ordered link list (BFS from root)
    const orderedLinks = [];
    const visited = new Set();
    const queue = [rootLink];
    const jointTree = robotData.jointTree || {};
    const allJoints = robotData.joints || {};

    while (queue.length) {
      const ln = queue.shift();
      if (visited.has(ln)) continue;
      visited.add(ln);
      orderedLinks.push(ln);
      for (const jn of (jointTree[ln] || [])) {
        const j = allJoints[jn];
        if (j && !visited.has(j.child)) queue.push(j.child);
      }
    }
    // Add any remaining links not reachable
    for (const ln of Object.keys(links)) {
      if (!visited.has(ln)) orderedLinks.push(ln);
    }

    const frag = document.createDocumentFragment();
    for (const linkName of orderedLinks) {
      const link = links[linkName];
      if (!link) continue;
      const activeCols = link.collisions.filter(c => !c.deleted);
      const node = this._buildLinkNode(linkName, activeCols, selectedId);
      frag.appendChild(node);
    }

    this._el.innerHTML = '';
    this._el.appendChild(frag);
  }

  setSelected(id) {
    this._el.querySelectorAll('.col-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.id === id);
    });
    // Ensure containing link is expanded
    if (id) {
      const item = this._el.querySelector(`.col-item[data-id="${id}"]`);
      if (item) {
        const children = item.closest('.link-children');
        if (children) children.classList.remove('hidden');
      }
    }
  }

  scrollToCollision(id) {
    const item = this._el.querySelector(`.col-item[data-id="${id}"]`);
    if (item) item.scrollIntoView({ block: 'nearest' });
  }

  // ── Private ────────────────────────────────────────────────────────────

  _buildLinkNode(linkName, collisions, selectedId) {
    const isOpen = this._open[linkName] !== false; // default open
    const node = document.createElement('div');
    node.className = 'link-node';

    // Header
    const header = document.createElement('div');
    header.className = 'link-header';
    header.innerHTML = `
      <span class="link-arrow ${isOpen ? 'open' : ''}">▶</span>
      <span class="link-icon">⚙</span>
      <span class="link-name" title="${linkName}">${linkName}</span>
      <button class="link-add-btn" title="添加碰撞体">+</button>
    `;

    const arrow   = header.querySelector('.link-arrow');
    const addBtn  = header.querySelector('.link-add-btn');
    const children = document.createElement('div');
    children.className = 'link-children' + (isOpen ? '' : ' hidden');

    // Toggle expand
    header.addEventListener('click', (e) => {
      if (e.target === addBtn) return;
      const open = !children.classList.contains('hidden');
      children.classList.toggle('hidden', open);
      arrow.classList.toggle('open', !open);
      this._open[linkName] = !open;
      this._cb.onFocusLink(linkName);
    });

    // Add button
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showPopup(e, linkName);
    });

    // Collision items
    collisions.forEach((col, idx) => {
      const icon = GEOM_ICONS[col.geometry.type] || '◎';
      const item = document.createElement('div');
      item.className = 'col-item' + (col.id === selectedId ? ' selected' : '');
      item.dataset.id       = col.id;
      item.dataset.linkName = linkName;
      item.innerHTML = `
        <span class="col-icon">${icon}</span>
        <span class="col-label">${col.geometry.type} [${idx}]</span>
        <button class="col-del-btn" title="删除">🗑</button>
      `;

      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('col-del-btn')) return;
        this._cb.onSelectCollision(col.id, linkName);
      });
      item.querySelector('.col-del-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this._cb.onDeleteCollision(col.id);
      });

      children.appendChild(item);
    });

    // Empty state
    if (collisions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'col-item';
      empty.style.color = 'var(--text-dim)';
      empty.style.pointerEvents = 'none';
      empty.innerHTML = `<span class="col-label" style="padding-left:4px">无碰撞体</span>`;
      children.appendChild(empty);
    }

    node.appendChild(header);
    node.appendChild(children);
    return node;
  }

  _showPopup(e, linkName) {
    this._pendingAddLink = linkName;
    const popup = this._addPopup;
    popup.style.display = 'block';
    // Position near the button
    const rect = e.target.getBoundingClientRect();
    popup.style.left = rect.left + 'px';
    popup.style.top  = (rect.bottom + 4) + 'px';
  }

  _hidePopup() {
    this._addPopup.style.display = 'none';
    this._pendingAddLink = null;
  }
}
