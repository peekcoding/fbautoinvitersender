// FB Page Inviter - invite engine.
// Knows nothing about sessions, the popup or the overlay. A caller (main.js today,
// a navigation module in Phase 2) hands it a dialog plus a context and gets back
//   { invited, failed, stoppedReason, durationMs, block?, error? }
//
// ctx = {
//   signal:     AbortSignal. Aborting stops everything, including pending waits.
//               signal.reason may be a stoppedReason string (default 'user_stop').
//   gate:       PauseGate (below). All waits freeze while it is paused.
//   getSettings(): current settings object (see storage.DEFAULTS).
//   limits:     { canInvite(): Promise<null | 'daily_limit' | 'session_limit'> }
//   onInvited(): Promise, called after each verified invite (persist counters here).
//   onEvent(state, data): progress notifications ('running' | 'scrolling' | 'break').
//   beforeClick(button): optional, called right before a click (overlay moves away).
// }
(function () {
  'use strict';
  const FBPI = (globalThis.FBPI = globalThis.FBPI || {});
  if (FBPI.engine) return;

  const VERIFY_TIMEOUT_MS = 3000;
  const VERIFY_POLL_MS = 50;
  const MAX_CONSECUTIVE_FAILS = 5;
  const PRE_CLICK_MIN_MS = 50;
  const PRE_CLICK_MAX_MS = 150;
  const IDLE_POLL_MS = 500;
  const RESCROLL_EVERY_MS = 2000;

  const STOP_REASONS = [
    'finished', 'user_stop', 'daily_limit', 'session_limit', 'blocked',
    'consecutive_failures', 'dialog_closed', 'navigation', 'error'
  ];

  class EngineStop extends Error {
    constructor(reason) {
      super(reason);
      this.name = 'EngineStop';
      this.reason = reason;
    }
  }

  function abortReason(signal) {
    return typeof signal?.reason === 'string' && STOP_REASONS.includes(signal.reason) ? signal.reason : 'user_stop';
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw new EngineStop(abortReason(signal));
  }

  // Pausable gate. Paused while at least one reason ('user', 'hidden', 'navigation') is set.
  class PauseGate {
    constructor() {
      this.reasons = new Set();
      this.waiters = [];
      this.onChange = null;
    }
    get paused() {
      return this.reasons.size > 0;
    }
    pause(reason = 'user') {
      if (this.reasons.has(reason)) return;
      this.reasons.add(reason);
      if (this.onChange) this.onChange();
    }
    resume(reason) {
      if (reason === undefined) this.reasons.clear();
      else this.reasons.delete(reason);
      if (!this.paused) {
        const w = this.waiters;
        this.waiters = [];
        w.forEach((fn) => fn());
      }
      if (this.onChange) this.onChange();
    }
    wait(signal) {
      if (!this.paused) return Promise.resolve();
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(new EngineStop(abortReason(signal)));
        const onAbort = () => reject(new EngineStop(abortReason(signal)));
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(() => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
  }

  function randBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new EngineStop(abortReason(signal)));
      const onAbort = () => {
        clearTimeout(t);
        reject(new EngineStop(abortReason(signal)));
      };
      const t = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Abortable delay that freezes while the gate is paused (e.g. tab hidden), so
  // a break countdown resumes where it left off. onTick(remainingMs) ~every 250 ms.
  async function delay(ms, ctx, onTick) {
    let remaining = ms;
    while (remaining > 0) {
      throwIfAborted(ctx.signal);
      if (ctx.gate && ctx.gate.paused) {
        await ctx.gate.wait(ctx.signal);
        continue;
      }
      const step = Math.min(250, remaining);
      const t = Date.now();
      await sleep(step, ctx.signal);
      if (!(ctx.gate && ctx.gate.paused)) remaining -= Math.max(step, Date.now() - t);
      if (onTick) onTick(Math.max(0, remaining));
    }
    throwIfAborted(ctx.signal);
  }

  function clickTookEffect(btn, labels) {
    const dom = FBPI.dom;
    return !btn.isConnected || !dom.isVisible(btn) || !dom.isInviteButton(btn, labels);
  }

  // Waits up to 3 s for the button to change. Not paused by the gate (the click
  // already happened); on abort it does one last check so a real invite is still counted.
  async function verifyClick(btn, labels, signal) {
    const end = Date.now() + VERIFY_TIMEOUT_MS;
    while (Date.now() < end) {
      if (clickTookEffect(btn, labels)) return true;
      if (signal && signal.aborted) return false;
      await new Promise((r) => setTimeout(r, VERIFY_POLL_MS));
    }
    return clickTookEffect(btn, labels);
  }

  async function runOnDialog(dialog, ctx) {
    const dom = FBPI.dom;
    const started = Date.now();
    const result = { invited: 0, failed: 0, stoppedReason: null, durationMs: 0 };
    const settings = () => ctx.getSettings();
    const labels = () => FBPI.storage.parseLabels(settings());
    const emit = (state, data = {}) => {
      if (ctx.onEvent) ctx.onEvent(state, { ...data, invited: result.invited, failed: result.failed });
    };
    const log = (...a) => FBPI.log && FBPI.log(...a);
    const debug = (...a) => FBPI.debug && FBPI.debug(...a);

    const blockBaseline = dom.snapshotBlockCandidates(dialog);
    const unlockPageScroll = dom.lockPageScroll(dialog);
    let consecutiveFails = 0;
    let sinceBreak = 0;

    const checkDialog = () => {
      if (!dialog.isConnected || !dom.isVisible(dialog)) throw new EngineStop('dialog_closed');
    };
    const checkBlock = () => {
      const block = dom.scanForBlock(blockBaseline, dialog);
      if (block) {
        result.block = block;
        throw new EngineStop('blocked');
      }
    };
    const checkLimits = async () => {
      const lim = await ctx.limits.canInvite();
      if (lim) throw new EngineStop(lim);
    };
    // Everything that must hold before we are allowed to click.
    const checkpoint = async () => {
      throwIfAborted(ctx.signal);
      if (ctx.gate) await ctx.gate.wait(ctx.signal);
      throwIfAborted(ctx.signal);
      checkDialog();
      checkBlock();
      await checkLimits();
      throwIfAborted(ctx.signal);
    };

    try {
      log('Engine started on dialog');
      emit('running');
      for (;;) {
        await checkpoint();
        const buttons = dom.findInviteButtons(dialog, labels());

        if (buttons.length) {
          const btn = buttons[0];
          // Mark first: a button that fails verification is not retried.
          dom.markProcessed(btn);
          dom.scrollIntoDialog(btn, dialog);
          await delay(randBetween(PRE_CLICK_MIN_MS, PRE_CLICK_MAX_MS), ctx);
          await checkpoint();
          if (!btn.isConnected || !dom.isInviteButton(btn, labels())) {
            debug('Button changed before click, skipping');
            continue;
          }
          if (ctx.beforeClick) ctx.beforeClick(btn);
          dom.simulateClick(btn);
          const ok = await verifyClick(btn, labels(), ctx.signal);
          if (ok) {
            result.invited++;
            consecutiveFails = 0;
            sinceBreak++;
            if (ctx.onInvited) await ctx.onInvited();
            debug('Invite verified', result.invited);
          } else {
            result.failed++;
            consecutiveFails++;
            log('Invite click not verified', `(${consecutiveFails} in a row)`);
          }
          emit('running');
          checkBlock();
          if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) throw new EngineStop('consecutive_failures');
          throwIfAborted(ctx.signal);
          await checkLimits();

          const s = settings();
          if (s.batchSize > 0 && sinceBreak >= s.batchSize) {
            sinceBreak = 0;
            const ms = randBetween(s.breakMin, s.breakMax) * 1000;
            log(`Batch of ${s.batchSize} done, break for ${Math.round(ms / 1000)} s`);
            emit('break', { remainingMs: ms });
            await delay(ms, ctx, (rem) => emit('break', { remainingMs: rem }));
            emit('running');
          } else {
            await delay(randBetween(s.minDelay, s.maxDelay) * 1000, ctx);
          }
          continue;
        }

        // No invite buttons on screen: scroll to load more people.
        emit('scrolling');
        const sc = dom.findScrollContainer(dialog);
        const rowsBefore = dom.countRows(dialog);
        const heightBefore = sc.scrollHeight;
        sc.scrollTop = sc.scrollHeight;
        debug('Scrolled', { rowsBefore, heightBefore });

        const idleMs = settings().idleWait * 1000;
        let waited = 0;
        let sinceScroll = 0;
        let grew = false;
        while (waited < idleMs) {
          await delay(IDLE_POLL_MS, ctx);
          waited += IDLE_POLL_MS;
          sinceScroll += IDLE_POLL_MS;
          checkDialog();
          const cur = dom.findScrollContainer(dialog);
          if (
            dom.countRows(dialog) !== rowsBefore ||
            cur.scrollHeight !== heightBefore ||
            dom.findInviteButtons(dialog, labels()).length
          ) {
            grew = true;
            break;
          }
          // Some lazy loaders need a fresh scroll event; nudge up and back down.
          if (sinceScroll >= RESCROLL_EVERY_MS) {
            sinceScroll = 0;
            cur.scrollTop = Math.max(0, cur.scrollHeight - cur.clientHeight - 200);
            await delay(150, ctx);
            cur.scrollTop = cur.scrollHeight;
          }
        }
        if (!grew) throw new EngineStop('finished');
        emit('running');
      }
    } catch (err) {
      if (err instanceof EngineStop) {
        result.stoppedReason = err.reason;
      } else {
        result.stoppedReason = 'error';
        result.error = String((err && err.message) || err);
        console.error('[FBPI] Engine error', err);
      }
    }
    unlockPageScroll();
    result.durationMs = Date.now() - started;
    log('Engine stopped:', result.stoppedReason, `invited=${result.invited} failed=${result.failed}`);
    return result;
  }

  FBPI.engine = {
    runOnDialog,
    PauseGate,
    EngineStop,
    delay,
    sleep,
    randBetween,
    STOP_REASONS,
    MAX_CONSECUTIVE_FAILS
  };
})();
