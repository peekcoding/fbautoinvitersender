// FB Page Inviter - controller. Wires storage, dom, engine and overlay together,
// owns the session state machine and talks to the popup via chrome.runtime messages.
(function () {
  'use strict';
  const FBPI = (globalThis.FBPI = globalThis.FBPI || {});
  if (FBPI.__booted) return; // guard against double injection
  FBPI.__booted = true;

  const { storage, dom, engine, overlay } = FBPI;
  const WATCH_INTERVAL_MS = 1000;

  let settings = { ...storage.DEFAULTS };
  FBPI.log = (...a) => console.log('[FBPI]', ...a);
  FBPI.debug = (...a) => settings.debug && console.debug('[FBPI]', ...a);
  const log = FBPI.log;

  const S = {
    state: 'idle',        // idle | running | scrolling | break | waiting_next | paused | stopped | blocked | limit
    message: 'Open a post’s likes popup, then press Start.',
    session: { active: false, invited: 0, failed: 0, posts: 0, startedAt: null },
    post: { invited: 0, failed: 0 },
    today: 0,
    cooldown: null,
    breakRemainingMs: null,
    engineState: 'running' // last state reported by the engine, restored on resume
  };

  const gate = new engine.PauseGate();
  let controller = null;   // AbortController of the running post
  let running = false;     // engine promise in flight
  let lastDialog = null;   // dialog of the last processed post
  let lastDialogGone = false;
  let watchTimer = null;   // waiting-for-next-post poll
  let lastUrl = location.href;
  let lastBroadcastSec = null;

  // ---- helpers ---------------------------------------------------------------

  const contextValid = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  };

  function snapshot() {
    return {
      state: S.state,
      message: S.message,
      paused: gate.paused,
      pauseReasons: [...gate.reasons],
      session: { ...S.session },
      post: { ...S.post },
      today: S.today,
      dailyLimit: settings.dailyLimit,
      sessionLimit: settings.sessionLimit,
      cooldown: S.cooldown,
      breakRemainingMs: S.breakRemainingMs,
      url: location.href
    };
  }

  function render() {
    overlay.update({
      state: S.state,
      message: S.message,
      postInvited: S.post.invited,
      today: S.today,
      dailyLimit: settings.dailyLimit,
      sessionInvited: S.session.invited,
      breakRemainingMs: S.breakRemainingMs,
      startDisabled: false
    });
    if (!contextValid()) return onContextLost();
    try {
      chrome.runtime.sendMessage({ type: 'STATE', state: snapshot() }).catch(() => {});
    } catch (_) {
      onContextLost();
    }
  }

  function setState(state, message) {
    S.state = state;
    if (message !== undefined) S.message = message;
    if (state !== 'break') S.breakRemainingMs = null;
    render();
  }

  // Extension reloaded/updated while this tab stayed open: storage and messaging
  // no longer work, so stop everything and ask for a refresh.
  let contextLost = false;
  function onContextLost() {
    if (contextLost) return;
    contextLost = true;
    if (controller) controller.abort('user_stop');
    clearWatch();
    S.state = 'stopped';
    S.message = 'Extension was reloaded. Refresh this tab to use it again.';
    overlay.update({ state: 'stopped', message: S.message, postInvited: S.post.invited, today: S.today, dailyLimit: settings.dailyLimit, sessionInvited: S.session.invited });
    console.warn('[FBPI] Extension context invalidated; refresh the tab.');
  }

  async function refreshCounters() {
    S.today = await storage.getDaily();
    S.cooldown = await storage.getCooldown();
  }

  async function limitReason() {
    S.today = await storage.getDaily();
    // 0 means no limit
    if (settings.dailyLimit > 0 && S.today >= settings.dailyLimit) return 'daily_limit';
    if (settings.sessionLimit > 0 && S.session.invited >= settings.sessionLimit) return 'session_limit';
    return null;
  }

  const LIMIT_MESSAGES = {
    daily_limit: () => 'Daily limit reached, continue tomorrow.',
    session_limit: () => `Session limit reached (${settings.sessionLimit}). Press Start to begin a new session.`
  };

  function fmtRemaining(ms) {
    const m = Math.ceil(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  }

  function clearWatch() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  }

  function endSession() {
    S.session.active = false;
    clearWatch();
  }

  // ---- run control -------------------------------------------------------------

  async function start({ override = false } = {}) {
    if (contextLost) return snapshot();
    if (running) return snapshot();
    await refreshCounters();

    if (S.cooldown && !override) {
      setState('blocked', `Facebook warning cooldown: ${fmtRemaining(S.cooldown.until - Date.now())} left. Override from the extension popup if you are sure.`);
      return snapshot();
    }
    if (S.cooldown && override) {
      log('Cooldown overridden by user');
      await storage.clearCooldown();
      S.cooldown = null;
    }

    // A new session starts unless we are continuing one (waiting between posts).
    if (!S.session.active) {
      S.session = { active: true, invited: 0, failed: 0, posts: 0, startedAt: Date.now() };
      gate.resume();
    }

    const lim = await limitReason();
    if (lim) {
      endSession();
      setState('limit', LIMIT_MESSAGES[lim]());
      return snapshot();
    }

    const dialog = dom.findLikesDialog(storage.parseLabels(settings));
    if (!dialog) {
      if (S.state === 'waiting_next' && watchTimer) {
        setState('waiting_next', 'Open a post’s likes popup first. Still waiting for it…');
        return snapshot();
      }
      endSession();
      setState('stopped', 'Open a post’s likes popup first.');
      return snapshot();
    }
    runPost(dialog);
    return snapshot();
  }

  async function runPost(dialog) {
    clearWatch();
    running = true;
    lastDialog = dialog;
    lastDialogGone = false;
    S.post = { invited: 0, failed: 0 };
    controller = new AbortController();
    const signal = controller.signal;
    setState(gate.paused ? 'paused' : 'running', 'Inviting…');

    const ctx = {
      signal,
      gate,
      getSettings: () => settings,
      limits: { canInvite: limitReason },
      onInvited: async () => {
        S.post.invited++;
        S.session.invited++;
        S.today = await storage.incrementDaily(1);
        render();
      },
      onEvent: (state, data) => {
        if (signal.aborted) return;
        S.post.failed = data.failed;
        S.engineState = state;
        if (state === 'break') {
          S.breakRemainingMs = data.remainingMs;
          const sec = Math.ceil(data.remainingMs / 1000);
          if (sec === lastBroadcastSec && S.state === 'break') return;
          lastBroadcastSec = sec;
        }
        if (gate.paused) return render();
        const msg = state === 'scrolling' ? 'Scrolling to load more people…'
          : state === 'break' ? 'Taking a short break to stay under Facebook’s radar.'
          : 'Inviting…';
        setState(state, msg);
      },
      beforeClick: (btn) => overlay.avoid(btn)
    };

    let result;
    try {
      result = await engine.runOnDialog(dialog, ctx);
    } finally {
      running = false;
      controller = null;
    }
    await onPostDone(result);
  }

  async function onPostDone(result) {
    const { invited, failed, stoppedReason } = result;
    S.session.failed += failed;
    if (contextLost) return;
    if (invited || failed || stoppedReason === 'finished') {
      S.session.posts++;
      await storage.addHistory({ url: location.href, invited, failed, stoppedReason });
    }

    switch (stoppedReason) {
      case 'finished':
        log(`Post finished, ${invited} invited, ${failed} failed`);
        if (settings.autoClose) {
          dom.closeDialog(lastDialog);
          log('Closed likes dialog');
        }
        return enterWaiting(`Post finished, ${invited} invited.`);
      case 'dialog_closed':
        return enterWaiting(`Likes popup closed, ${invited} invited on that post.`);
      case 'user_stop':
        // stop() already updated the state.
        return;
      case 'daily_limit':
      case 'session_limit':
        endSession();
        return setState('limit', LIMIT_MESSAGES[stoppedReason]());
      case 'blocked': {
        const until = Date.now() + settings.cooldownHours * 3600 * 1000;
        const phrase = result.block ? result.block.phrase : 'warning';
        await storage.setCooldown(until, `Facebook warning ("${phrase}")`);
        S.cooldown = await storage.getCooldown();
        endSession();
        console.warn('[FBPI] Facebook warning detected, stopping:', result.block);
        return setState('blocked', `Facebook warning detected ("${phrase}"). Stopped. Start is disabled for ${settings.cooldownHours} h.`);
      }
      case 'consecutive_failures':
        endSession();
        return setState('stopped', 'Clicks are not working, Facebook may have changed its layout.');
      default:
        endSession();
        return setState('stopped', `Stopped because of an error: ${result.error || stoppedReason}. See console for details.`);
    }
  }

  function enterWaiting(prefix) {
    if (!settings.autoContinue) {
      setState('idle', `${prefix} Open the next post’s likes popup and press Start.`);
      return;
    }
    setState('waiting_next', `${prefix} Waiting for the next post’s likes popup…`);
    clearWatch();
    watchTimer = setInterval(() => {
      if (running || gate.paused || !S.session.active) return;
      if (lastDialog && !dom.isVisible(lastDialog)) lastDialogGone = true;
      const d = dom.findLikesDialog(storage.parseLabels(settings));
      if (!d) return;
      if (d === lastDialog && !lastDialogGone) return;
      if (!dom.findInviteButtons(d, storage.parseLabels(settings)).length) return;
      log('New likes popup detected, continuing');
      limitReason().then((lim) => {
        if (running || !S.session.active) return;
        if (lim) {
          endSession();
          return setState('limit', LIMIT_MESSAGES[lim]());
        }
        runPost(d);
      });
    }, WATCH_INTERVAL_MS);
  }

  function stop() {
    log('Stop requested');
    // Keep a Blocked / Limit message visible if nothing is running.
    if (!running && !S.session.active && (S.state === 'blocked' || S.state === 'limit')) return snapshot();
    if (controller) controller.abort('user_stop');
    endSession();
    gate.resume();
    setState('stopped', `Stopped. ${S.session.invited} invited this session.`);
    return snapshot();
  }

  function pause() {
    if (!running) return snapshot();
    gate.pause('user');
    setState('paused', 'Paused.');
    return snapshot();
  }

  function resume() {
    gate.resume('user');
    gate.resume('navigation');
    if (running && !gate.paused) setState(S.engineState === 'break' ? 'break' : S.engineState, 'Inviting…');
    else if (running) setState('paused', 'Paused while the tab is hidden.');
    return snapshot();
  }

  // ---- page events ---------------------------------------------------------------

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      gate.pause('hidden');
      if (running) setState('paused', 'Paused while the tab is hidden.');
    } else {
      gate.resume('hidden');
      if (running && !gate.paused) setState(S.engineState, 'Inviting…');
      else if (running) render();
    }
  });

  // Facebook is a single page app: poll the URL. Navigation during an active run
  // pauses it; navigation while waiting between posts is expected and ignored.
  setInterval(() => {
    if (location.href === lastUrl) return;
    const from = lastUrl;
    lastUrl = location.href;
    FBPI.debug('URL changed', from, '->', lastUrl);
    if (running && !gate.reasons.has('navigation')) {
      gate.pause('navigation');
      setState('paused', 'Page changed. Check the likes popup is still open, then press Resume.');
    }
  }, WATCH_INTERVAL_MS);

  overlay.onAction((action) => {
    if (action === 'start') {
      if (S.cooldown && S.cooldown.until > Date.now()) {
        const ok = window.confirm(
          `FB Page Inviter: Facebook showed a warning ${fmtRemaining(Date.now() - S.cooldown.at)} ago.\n` +
          `Cooldown remaining: ${fmtRemaining(S.cooldown.until - Date.now())}.\n\n` +
          'Continuing may get the invite feature or your account restricted. Override anyway?'
        );
        if (ok) start({ override: true });
        return;
      }
      start();
    } else if (action === 'stop') stop();
    else if (action === 'pause') pause();
    else if (action === 'resume') resume();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    const reply = (p) => Promise.resolve(p).then(sendResponse, (e) => sendResponse({ error: String(e) }));
    switch (msg.type) {
      case 'GET_STATE':
        reply(refreshCounters().then(() => (render(), snapshot())));
        return true;
      case 'START':
        reply(start({ override: !!msg.override }));
        return true;
      case 'PAUSE':
        reply(pause());
        return true;
      case 'RESUME':
        reply(resume());
        return true;
      case 'STOP':
        reply(stop());
        return true;
      default:
        return;
    }
  });

  storage.onSettingsChanged((s) => {
    settings = s;
    FBPI.debug('Settings updated', s);
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[storage.KEYS.daily] || changes[storage.KEYS.cooldown]) {
      refreshCounters().then(render, () => {});
    }
  });

  // ---- boot -------------------------------------------------------------------

  (async () => {
    settings = await storage.getSettings();
    await refreshCounters();
    await overlay.mount();
    if (S.cooldown) {
      S.state = 'blocked';
      S.message = `Facebook warning cooldown: ${fmtRemaining(S.cooldown.until - Date.now())} left.`;
    }
    render();
    log('Content script ready on', location.href);
  })().catch((e) => console.error('[FBPI] boot failed', e));

  // Exposed for Phase 2 / debugging.
  FBPI.controller = { start, stop, pause, resume, getState: snapshot, gate };
})();
