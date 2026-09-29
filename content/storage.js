// FB Page Inviter - storage module.
// Settings, per-day counters, history and block cooldown, all in chrome.storage.local.
// Loaded both as a content script and by popup.html, so it must not touch the page DOM.
(function () {
  'use strict';
  const FBPI = (globalThis.FBPI = globalThis.FBPI || {});
  if (FBPI.storage) return;

  const DEFAULTS = Object.freeze({
    minDelay: 0,        // seconds, min wait between invite clicks
    maxDelay: 1,        // seconds, max wait between invite clicks
    batchSize: 0,       // take a break after this many invites (0 = never)
    breakMin: 60,       // seconds
    breakMax: 120,      // seconds
    dailyLimit: 0,      // 0 = no limit
    sessionLimit: 0,    // 0 = no limit
    idleWait: 10,       // seconds without new rows before a post counts as finished
    inviteLabels: 'Invite', // comma separated, case insensitive exact match
    autoClose: false,
    autoContinue: true,
    cooldownHours: 24,  // Start is disabled this long after a Facebook warning
    debug: false,
    settingsVersion: 2
  });
  // Fields whose defaults changed in settingsVersion 2; older saved values are replaced once.
  const V2_FIELDS = ['minDelay', 'maxDelay', 'batchSize', 'dailyLimit', 'sessionLimit'];

  const KEYS = {
    settings: 'settings',
    daily: 'daily',       // { 'YYYY-MM-DD': count }
    history: 'history',   // [{ time, url, invited, failed, stoppedReason }]
    cooldown: 'cooldown', // { until, reason, at }
    overlayPos: 'overlayPos'
  };
  const HISTORY_MAX = 100;
  const DAILY_KEEP_DAYS = 30;

  const area = () => chrome.storage.local;
  const get = (key) => area().get(key).then((r) => r[key]);
  const set = (key, value) => area().set({ [key]: value });

  function validate(input) {
    const errors = [];
    const clean = {};
    const num = (name, min, integer) => {
      const raw = input[name];
      const v = Number(raw);
      if (raw === '' || raw === null || raw === undefined || !Number.isFinite(v)) {
        errors.push(`${name} must be a number`);
        clean[name] = DEFAULTS[name];
        return;
      }
      if (v < 0) errors.push(`${name} cannot be negative`);
      else if (v < min) errors.push(`${name} must be at least ${min}`);
      if (integer && !Number.isInteger(v)) errors.push(`${name} must be a whole number`);
      clean[name] = v;
    };
    num('minDelay', 0, false);
    num('maxDelay', 0, false);
    num('batchSize', 0, true);
    num('breakMin', 0, false);
    num('breakMax', 0, false);
    num('dailyLimit', 0, true);
    num('sessionLimit', 0, true);
    num('idleWait', 3, false);
    num('cooldownHours', 0, false);
    if (clean.minDelay > clean.maxDelay) errors.push('minDelay cannot exceed maxDelay');
    if (clean.breakMin > clean.breakMax) errors.push('breakMin cannot exceed breakMax');

    const labels = String(input.inviteLabels ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!labels.length) errors.push('Enter at least one invite button label');
    clean.inviteLabels = labels.join(', ');
    clean.autoClose = !!input.autoClose;
    clean.autoContinue = !!input.autoContinue;
    clean.debug = !!input.debug;
    clean.settingsVersion = DEFAULTS.settingsVersion;
    return { ok: errors.length === 0, errors, clean };
  }

  function parseLabels(settings) {
    return String(settings.inviteLabels || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  async function getSettings() {
    const stored = (await get(KEYS.settings)) || {};
    if (Object.keys(stored).length && stored.settingsVersion !== DEFAULTS.settingsVersion) {
      for (const k of V2_FIELDS) delete stored[k];
      stored.settingsVersion = DEFAULTS.settingsVersion;
      await set(KEYS.settings, stored);
    }
    return { ...DEFAULTS, ...stored };
  }

  async function saveSettings(settings) {
    const res = validate(settings);
    if (!res.ok) return res;
    await set(KEYS.settings, res.clean);
    return res;
  }

  function onSettingsChanged(cb) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[KEYS.settings]) {
        cb({ ...DEFAULTS, ...(changes[KEYS.settings].newValue || {}) });
      }
    });
  }

  // Local calendar date, so "today" matches the user's clock rather than UTC.
  function dateKey(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const todayKey = () => dateKey();

  async function getDaily(date = todayKey()) {
    const daily = (await get(KEYS.daily)) || {};
    return daily[date] || 0;
  }

  async function incrementDaily(n = 1) {
    const daily = (await get(KEYS.daily)) || {};
    const key = todayKey();
    daily[key] = (daily[key] || 0) + n;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DAILY_KEEP_DAYS);
    const cutoffKey = dateKey(cutoff);
    for (const k of Object.keys(daily)) if (k < cutoffKey) delete daily[k];
    await set(KEYS.daily, daily);
    return daily[key];
  }

  async function getLastNDays(n = 7) {
    const daily = (await get(KEYS.daily)) || {};
    const out = [];
    for (let i = 0; i < n; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = dateKey(d);
      out.push({ date: k, count: daily[k] || 0 });
    }
    return out;
  }

  async function addHistory(entry) {
    const history = (await get(KEYS.history)) || [];
    history.unshift({ time: Date.now(), ...entry });
    history.length = Math.min(history.length, HISTORY_MAX);
    await set(KEYS.history, history);
  }

  async function getHistory() {
    return (await get(KEYS.history)) || [];
  }

  async function getCooldown() {
    const c = await get(KEYS.cooldown);
    if (!c || !c.until || c.until <= Date.now()) return null;
    return c;
  }

  async function setCooldown(until, reason) {
    await set(KEYS.cooldown, { until, reason, at: Date.now() });
  }

  async function clearCooldown() {
    await area().remove(KEYS.cooldown);
  }

  async function resetStats() {
    await area().remove([KEYS.daily, KEYS.history]);
  }

  async function getOverlayPos() {
    return (await get(KEYS.overlayPos)) || null;
  }

  async function setOverlayPos(pos) {
    await set(KEYS.overlayPos, pos);
  }

  FBPI.storage = {
    DEFAULTS,
    KEYS,
    validate,
    parseLabels,
    getSettings,
    saveSettings,
    onSettingsChanged,
    todayKey,
    getDaily,
    incrementDaily,
    getLastNDays,
    addHistory,
    getHistory,
    getCooldown,
    setCooldown,
    clearCooldown,
    resetStats,
    getOverlayPos,
    setOverlayPos
  };
})();
