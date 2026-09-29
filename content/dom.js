// FB Page Inviter - every Facebook DOM lookup lives here.
// Facebook changes its markup often. When the extension stops finding things,
// update FB_CONFIG below first; the rest of the code should not need changes.
(function () {
  'use strict';
  const FBPI = (globalThis.FBPI = globalThis.FBPI || {});
  if (FBPI.dom) return;

  const FB_CONFIG = {
    // Popups/modals. The reactions ("likes") list is a role="dialog" layer that
    // Facebook appends to the end of <body>, so the last visible one is the topmost.
    dialogSelector: '[role="dialog"]',

    // Anything clickable. Facebook mostly uses <div role="button">; <button> is kept
    // for localized/older layouts and for the test mock.
    buttonSelector: '[role="button"], button',

    // Labels (aria-label or visible text, lowercase, exact match) of the action
    // button shown at the end of each person row in the reactions list. A dialog
    // counts as a likes popup only if it contains at least one of these.
    // Add your language's words here (e.g. 'invitar', 'inviter', 'einladen').
    rowActionLabels: [
      'invite', 'invited', 'liked', 'following', 'follow',
      'add friend', 'message', 'friends', 'cancel request'
    ],

    // Close button of a dialog (aria-label, lowercase, exact match).
    closeLabels: ['close', 'cerrar', 'fermer', 'schließen', 'fechar'],

    // Places where Facebook shows warnings: other dialogs, alert dialogs, toasts
    // and live regions. Scanned after every click (the likes dialog itself and our
    // overlay are excluded; alerts inside the likes dialog are still checked).
    blockScanSelectors: '[role="dialog"], [role="alertdialog"], [role="alert"], [role="status"]',
    innerAlertSelectors: '[role="alertdialog"], [role="alert"], [role="status"]',

    // Lowercase phrases that mean Facebook is rate limiting or blocking.
    // Extend freely; matching is a simple substring test on lowercase text.
    // Note: apostrophes are normalised (’ -> ') before matching.
    blockPhrases: [
      'try again later',
      "can't use this feature",
      'cannot use this feature',
      'temporarily blocked',
      "you're going too fast",
      'you are going too fast',
      'limit',
      'misusing',
      'restricted',
      'we limit how often'
    ],

    // Attribute we set on invite buttons we already handled.
    processedAttr: 'data-fbpi-done',

    // Host element id of our own overlay (excluded from every scan).
    overlayHostId: 'fbpi-overlay-host'
  };

  const norm = (s) => String(s || '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  }

  function isOverlay(el) {
    const host = document.getElementById(FB_CONFIG.overlayHostId);
    return !!host && (el === host || host.contains(el));
  }

  // Both the aria-label and the visible text, normalised.
  function labelsOf(el) {
    return [norm(el.getAttribute('aria-label')), norm(el.innerText)].filter(Boolean);
  }

  function matchesAny(el, list) {
    return labelsOf(el).some((l) => list.includes(l));
  }

  // Only the outermost matching button, so nested role=button wrappers are not
  // counted (or clicked) twice.
  function outermost(els) {
    const set = new Set(els);
    return els.filter((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
  }

  function rowActionButtons(dialog) {
    const all = [...dialog.querySelectorAll(FB_CONFIG.buttonSelector)];
    return outermost(all.filter((b) => matchesAny(b, FB_CONFIG.rowActionLabels)));
  }

  function countRows(dialog) {
    return dialog ? rowActionButtons(dialog).length : 0;
  }

  // Topmost visible dialog with person rows. Iterates from the end of the document,
  // so layers appended later (and dialogs nested inside others) win. When `labels`
  // is given, a dialog that still has Invite buttons is preferred over one that
  // only has rows (e.g. a post modal with a "Follow" button behind the likes popup).
  function findLikesDialog(labels) {
    const dialogs = [...document.querySelectorAll(FB_CONFIG.dialogSelector)]
      .filter((d) => !isOverlay(d) && isVisible(d))
      .reverse();
    if (labels && labels.length) {
      const withInvites = dialogs.find((d) => findInviteButtons(d, labels).length);
      if (withInvites) return withInvites;
    }
    return dialogs.find((d) => rowActionButtons(d).some(isVisible)) || null;
  }

  function isInviteButton(el, labels) {
    if (!el || !el.isConnected) return false;
    if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return false;
    return matchesAny(el, labels);
  }

  function findInviteButtons(dialog, labels) {
    if (!dialog) return [];
    const all = [...dialog.querySelectorAll(FB_CONFIG.buttonSelector)];
    return outermost(all.filter((b) => matchesAny(b, labels)))
      .filter((b) => !b.hasAttribute(FB_CONFIG.processedAttr))
      .filter((b) => isInviteButton(b, labels) && isVisible(b));
  }

  function markProcessed(el) {
    el.setAttribute(FB_CONFIG.processedAttr, '1');
    el.querySelectorAll(FB_CONFIG.buttonSelector).forEach((b) => b.setAttribute(FB_CONFIG.processedAttr, '1'));
  }

  // The list that holds the people: the scrollable ancestor of the last person row.
  // Falls back to the largest scrollable element inside the dialog.
  function findScrollContainer(dialog) {
    const rows = rowActionButtons(dialog);
    if (rows.length) {
      const list = scrollableAncestor(rows[rows.length - 1], dialog);
      if (list) return list;
    }
    let best = null;
    let bestH = 0;
    for (const el of dialog.querySelectorAll('*')) {
      if (el.scrollHeight <= el.clientHeight + 2) continue;
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > bestH) {
        best = el;
        bestH = el.scrollHeight;
      }
    }
    return best || dialog;
  }

  // Centre `el` inside its nearest scrollable ancestor within `dialog`, without
  // touching the page behind (Element.scrollIntoView would also scroll the feed).
  function scrollIntoDialog(el, dialog) {
    const p = scrollableAncestor(el, dialog);
    if (!p) return;
    const pr = p.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    p.scrollTop += er.top - pr.top - (pr.height - er.height) / 2;
  }

  function isScrollable(el) {
    if (el.scrollHeight <= el.clientHeight + 2) return false;
    const oy = getComputedStyle(el).overflowY;
    return oy === 'auto' || oy === 'scroll';
  }

  // Nearest scrollable ancestor of `el`, never going above `dialog`.
  function scrollableAncestor(el, dialog) {
    for (let p = el.parentElement; p && p !== dialog.parentElement; p = p.parentElement) {
      if (isScrollable(p)) return p;
    }
    return null;
  }

  // ---- Page scroll lock ----------------------------------------------------------
  // While a post is being processed, anything outside the likes dialog that scrolls
  // (the feed/page behind it, e.g. because Facebook moves focus after an invite)
  // is put straight back, so the feed does not start loading more posts.
  function lockPageScroll(dialog) {
    const saved = new Map();
    const root = document.scrollingElement || document.documentElement;
    saved.set(root, { top: root.scrollTop, left: root.scrollLeft });
    // Other scrollable containers outside the dialog (Facebook sometimes scrolls a
    // wrapper div instead of the document).
    for (const el of document.body.querySelectorAll('div, main')) {
      if (dialog.contains(el) || el.contains(dialog) || isOverlay(el)) continue;
      if (el.scrollTop > 0 || isScrollable(el)) saved.set(el, { top: el.scrollTop, left: el.scrollLeft });
    }
    // Ancestors of the dialog (e.g. the layer container) must not scroll either.
    for (let p = dialog.parentElement; p && p !== document.body; p = p.parentElement) {
      saved.set(p, { top: p.scrollTop, left: p.scrollLeft });
    }

    const onScroll = (e) => {
      let t = e.target;
      if (t === document || t === window) t = root;
      if (!(t instanceof Element) || dialog.contains(t) || isOverlay(t)) return;
      const pos = saved.get(t);
      if (!pos) return;
      if (t.scrollTop !== pos.top || t.scrollLeft !== pos.left) {
        t.scrollTop = pos.top;
        t.scrollLeft = pos.left;
        FBPI.debug && FBPI.debug('Page scroll blocked on', t === root ? 'document' : t);
      }
    };
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('scroll', onScroll, true);
    return function unlock() {
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }

  function simulateClick(el) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0
    };
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function closeDialog(dialog) {
    if (!dialog || !dialog.isConnected) return false;
    const btn = [...dialog.querySelectorAll(FB_CONFIG.buttonSelector + ', [aria-label]')]
      .find((b) => FB_CONFIG.closeLabels.includes(norm(b.getAttribute('aria-label'))) && isVisible(b));
    if (btn) {
      simulateClick(btn);
      return true;
    }
    const esc = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    for (const target of [dialog, document]) {
      target.dispatchEvent(new KeyboardEvent('keydown', esc));
      target.dispatchEvent(new KeyboardEvent('keyup', esc));
    }
    return true;
  }

  // ---- Block detection -----------------------------------------------------
  // To avoid false positives from content already on screen (e.g. the post modal
  // behind the likes popup containing a comment with the word "limit"), a baseline
  // is taken when a post starts. Only new elements, or phrases that newly appear
  // in an element's text, trigger a block.

  function blockCandidates(likesDialog) {
    const out = [];
    for (const el of document.querySelectorAll(FB_CONFIG.blockScanSelectors)) {
      if (isOverlay(el)) continue;
      if (likesDialog && (el === likesDialog || likesDialog.contains(el))) continue;
      if (likesDialog && el.contains(likesDialog)) continue; // ancestor layers
      out.push(el);
    }
    if (likesDialog) {
      for (const el of likesDialog.querySelectorAll(FB_CONFIG.innerAlertSelectors)) out.push(el);
    }
    return out.filter(isVisible);
  }

  function phrasesIn(text) {
    return FB_CONFIG.blockPhrases.filter((p) => text.includes(p));
  }

  function snapshotBlockCandidates(likesDialog) {
    const baseline = new Map();
    for (const el of blockCandidates(likesDialog)) baseline.set(el, norm(el.innerText));
    return baseline;
  }

  // Returns { phrase, text } or null. Updates the baseline in place.
  function scanForBlock(baseline, likesDialog) {
    for (const el of blockCandidates(likesDialog)) {
      const text = norm(el.innerText);
      const before = baseline.get(el);
      baseline.set(el, text);
      if (before === text) continue;
      const found = phrasesIn(text).filter((p) => !(before && before.includes(p)));
      if (found.length) return { phrase: found[0], text: text.slice(0, 200) };
    }
    return null;
  }

  FBPI.dom = {
    FB_CONFIG,
    norm,
    isVisible,
    isOverlay,
    findLikesDialog,
    countRows,
    findInviteButtons,
    isInviteButton,
    markProcessed,
    findScrollContainer,
    scrollIntoDialog,
    lockPageScroll,
    simulateClick,
    closeDialog,
    snapshotBlockCandidates,
    scanForBlock
  };
})();
