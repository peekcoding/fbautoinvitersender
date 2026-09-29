// FB Page Inviter - floating status panel.
// Rendered inside a Shadow DOM so Facebook's CSS cannot touch it. The host element
// id is excluded from all DOM scans in dom.js.
(function () {
  'use strict';
  const FBPI = (globalThis.FBPI = globalThis.FBPI || {});
  if (FBPI.overlay) return;

  const STATE_LABELS = {
    idle: 'Idle',
    running: 'Running',
    scrolling: 'Scrolling',
    break: 'On break',
    waiting_next: 'Waiting for next post',
    paused: 'Paused',
    stopped: 'Stopped',
    blocked: 'Blocked',
    limit: 'Limit reached'
  };

  const CSS = `
    :host { all: initial; }
    .panel {
      position: fixed; z-index: 2147483647; width: 250px;
      font: 13px/1.4 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      color: #1c1e21; background: #fff; border: 1px solid #ccd0d5; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,.18); overflow: hidden; user-select: none;
    }
    .head {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      background: #f0f2f5; cursor: move; touch-action: none;
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #8a8d91; flex: none; }
    .title { flex: 1; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .icon { border: 0; background: transparent; cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 4px; color: #65676b; }
    .body { padding: 8px 10px 10px; }
    .collapsed .body { display: none; }
    .msg { margin: 0 0 8px; color: #65676b; min-height: 1.4em; word-wrap: break-word; }
    .grid { display: grid; grid-template-columns: 1fr auto; row-gap: 2px; margin-bottom: 8px; }
    .grid b { font-variant-numeric: tabular-nums; }
    .btns { display: flex; gap: 6px; }
    .btns button {
      flex: 1; padding: 6px 0; border-radius: 6px; border: 1px solid #ccd0d5; background: #fff;
      font: inherit; font-weight: 600; cursor: pointer; color: #1c1e21;
    }
    .btns button.primary { background: #1877f2; border-color: #1877f2; color: #fff; }
    .btns button.danger { color: #c62828; }
    .btns button[hidden] { display: none; }
    .running .dot, .scrolling .dot { background: #31a24c; }
    .break .dot, .paused .dot, .waiting_next .dot { background: #f5a623; }
    .limit .dot { background: #8e24aa; }
    .blocked .dot { background: #d32f2f; }
    .blocked .head { background: #fdecea; }
    .blocked .msg { color: #b71c1c; font-weight: 600; }
  `;

  let host = null;
  let root = null;
  let els = {};
  let actionCb = null;
  let userPos = null; // {left, top} if the user dragged it
  let collapsed = false;

  function h(tag, attrs = {}, text) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function applyPos(pos) {
    const p = els.panel;
    if (pos) {
      const maxL = window.innerWidth - p.offsetWidth - 4;
      const maxT = window.innerHeight - p.offsetHeight - 4;
      p.style.left = Math.max(4, Math.min(pos.left, maxL)) + 'px';
      p.style.top = Math.max(4, Math.min(pos.top, maxT)) + 'px';
      p.style.right = 'auto';
      p.style.bottom = 'auto';
    } else {
      p.style.left = 'auto';
      p.style.top = 'auto';
      p.style.right = '16px';
      p.style.bottom = '16px';
    }
  }

  function enableDrag() {
    let start = null;
    els.head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = els.panel.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      els.head.setPointerCapture(e.pointerId);
    });
    els.head.addEventListener('pointermove', (e) => {
      if (!start) return;
      userPos = { left: start.left + e.clientX - start.x, top: start.top + e.clientY - start.y };
      applyPos(userPos);
    });
    els.head.addEventListener('pointerup', () => {
      if (!start) return;
      start = null;
      FBPI.storage.getOverlayPos().then((saved) =>
        FBPI.storage.setOverlayPos({ ...(saved || {}), left: userPos && userPos.left, top: userPos && userPos.top, collapsed })
      );
    });
  }

  async function mount() {
    if (host && host.isConnected) return;
    host = document.getElementById(FBPI.dom.FB_CONFIG.overlayHostId);
    if (host) host.remove();
    host = h('div', { id: FBPI.dom.FB_CONFIG.overlayHostId });
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(h('style', {}, CSS));

    const panel = h('div', { class: 'panel idle' });
    const head = h('div', { class: 'head' });
    head.append(h('span', { class: 'dot' }), h('span', { class: 'title' }, 'FB Page Inviter'));
    const collapseBtn = h('button', { class: 'icon', title: 'Collapse / expand' }, '–');
    head.append(collapseBtn);

    const body = h('div', { class: 'body' });
    const msg = h('p', { class: 'msg' }, 'Open a post’s likes popup, then press Start.');
    const grid = h('div', { class: 'grid' });
    const row = (label) => {
      const v = h('b', {}, '0');
      grid.append(h('span', {}, label), v);
      return v;
    };
    const postV = row('Invited this post');
    const todayV = row('Invited today');
    const sessionV = row('Session total');
    const btns = h('div', { class: 'btns' });
    const startBtn = h('button', { class: 'primary' }, 'Start');
    const pauseBtn = h('button', {}, 'Pause');
    const stopBtn = h('button', { class: 'danger' }, 'Stop');
    btns.append(startBtn, pauseBtn, stopBtn);
    body.append(msg, grid, btns);
    panel.append(head, body);
    root.appendChild(panel);
    (document.body || document.documentElement).appendChild(host);

    els = { panel, head, title: head.querySelector('.title'), msg, postV, todayV, sessionV, startBtn, pauseBtn, stopBtn, collapseBtn };

    startBtn.addEventListener('click', () => actionCb && actionCb('start'));
    stopBtn.addEventListener('click', () => actionCb && actionCb('stop'));
    pauseBtn.addEventListener('click', () => actionCb && actionCb(pauseBtn.dataset.action));
    collapseBtn.addEventListener('click', () => setCollapsed(!collapsed, true));
    enableDrag();
    window.addEventListener('resize', () => applyPos(userPos));

    const saved = await FBPI.storage.getOverlayPos();
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) userPos = { left: saved.left, top: saved.top };
    applyPos(userPos);
    setCollapsed(!!(saved && saved.collapsed), false);
  }

  function setCollapsed(v, persist) {
    collapsed = v;
    els.panel.classList.toggle('collapsed', v);
    els.collapseBtn.textContent = v ? '+' : '–';
    if (persist) {
      FBPI.storage.getOverlayPos().then((saved) => FBPI.storage.setOverlayPos({ ...(saved || {}), collapsed: v }));
    }
  }

  function fmtSecs(ms) {
    const s = Math.ceil(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  }

  // view = { state, message, postInvited, today, dailyLimit, sessionInvited, breakRemainingMs, paused }
  function update(view) {
    if (!els.panel) return;
    const state = view.state || 'idle';
    els.panel.className = `panel ${state}${collapsed ? ' collapsed' : ''}`;
    let label = STATE_LABELS[state] || state;
    if (state === 'break' && view.breakRemainingMs != null) label += ` (${fmtSecs(view.breakRemainingMs)})`;
    els.title.textContent = `FBPI · ${label}`;
    els.msg.textContent = view.message || '';
    els.postV.textContent = String(view.postInvited || 0);
    els.todayV.textContent = view.dailyLimit > 0 ? `${view.today || 0} / ${view.dailyLimit}` : String(view.today || 0);
    els.sessionV.textContent = String(view.sessionInvited || 0);

    const active = ['running', 'scrolling', 'break', 'waiting_next', 'paused'].includes(state);
    els.startBtn.hidden = active;
    els.startBtn.disabled = !!view.startDisabled;
    els.pauseBtn.hidden = !active || state === 'waiting_next';
    els.stopBtn.hidden = !active;
    const isPaused = state === 'paused';
    els.pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
    els.pauseBtn.dataset.action = isPaused ? 'resume' : 'pause';
    if (state === 'blocked' && collapsed) setCollapsed(false, false);
  }

  function onAction(cb) {
    actionCb = cb;
  }

  // Move the panel out of the way if it overlaps the element we are about to click.
  function avoid(target) {
    if (!els.panel || !target) return;
    const a = els.panel.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const overlap = !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    if (!overlap) return;
    const goLeft = b.left + b.width / 2 > window.innerWidth / 2;
    const left = goLeft ? 16 : window.innerWidth - a.width - 16;
    userPos = { left, top: a.top };
    applyPos(userPos);
    FBPI.debug && FBPI.debug('Overlay moved out of the way');
  }

  function destroy() {
    if (host) host.remove();
    host = null;
    root = null;
    els = {};
  }

  FBPI.overlay = { mount, update, onAction, avoid, destroy, STATE_LABELS };
})();
