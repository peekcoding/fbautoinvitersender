// FB Page Inviter - popup: settings, controls, live status and stats.
(function () {
  'use strict';
  const { storage } = globalThis.FBPI;
  const $ = (id) => document.getElementById(id);

  // Pages where the content script runs. Keep in sync with manifest.json.
  const SUPPORTED = [/^https:\/\/(www|web)\.facebook\.com\//];

  const STATE_LABELS = {
    idle: 'Idle', running: 'Running', scrolling: 'Scrolling', break: 'On break',
    waiting_next: 'Waiting for next post', paused: 'Paused', stopped: 'Stopped',
    blocked: 'Blocked', limit: 'Limit reached', offline: 'Not connected'
  };
  const ACTIVE = ['running', 'scrolling', 'break', 'waiting_next', 'paused'];

  let tabId = null;
  let connected = false;
  let live = null;       // last state snapshot from the content script
  let settings = null;
  let cooldown = null;

  // ---- helpers ---------------------------------------------------------------

  function fmtRemaining(ms) {
    const m = Math.max(1, Math.ceil(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function setStatus(text, isError) {
    $('status').textContent = text;
    $('status').classList.toggle('error', !!isError);
  }

  async function send(type, extra = {}) {
    if (tabId == null) throw new Error('No tab');
    return chrome.tabs.sendMessage(tabId, { type, ...extra });
  }

  // ---- rendering ---------------------------------------------------------------

  async function renderCounters() {
    const today = await storage.getDaily();
    const limit = settings.dailyLimit;
    $('cToday').textContent = today;
    $('cLeft').textContent = limit > 0 ? Math.max(0, limit - today) : '∞';
    $('cPost').textContent = live ? live.post.invited : 0;
    $('cSession').textContent = live ? live.session.invited : 0;
    $('cPosts').textContent = live ? live.session.posts : 0;
  }

  function renderControls() {
    const state = connected && live ? live.state : 'offline';
    const badge = $('stateBadge');
    let label = STATE_LABELS[state] || state;
    if (state === 'break' && live.breakRemainingMs != null) label += ` ${Math.ceil(live.breakRemainingMs / 1000)}s`;
    badge.textContent = label;
    badge.className = `badge ${state}`;

    const active = ACTIVE.includes(state);
    const inCooldown = !!(cooldown && cooldown.until > Date.now());
    $('startBtn').disabled = !connected || active || inCooldown;
    $('pauseBtn').disabled = !connected || !['running', 'scrolling', 'break', 'paused'].includes(state);
    $('pauseBtn').textContent = state === 'paused' ? 'Resume' : 'Pause';
    $('stopBtn').disabled = !connected || !active;

    $('cooldown').hidden = !inCooldown;
    $('overrideBtn').hidden = !inCooldown || !connected || active;
    if (inCooldown) {
      $('cooldown').textContent = `${cooldown.reason || 'Facebook warning'} at ${fmtTime(cooldown.at)}. ` +
        `Start is disabled for another ${fmtRemaining(cooldown.until - Date.now())}.`;
    }
    if (connected && live) setStatus(live.message, state === 'blocked');
  }

  async function renderStats() {
    const days = await storage.getLastNDays(7);
    $('daysTable').innerHTML = '';
    for (const d of days) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td class="num"></td>';
      tr.children[0].textContent = d.date;
      tr.children[1].textContent = d.count;
      $('daysTable').appendChild(tr);
    }
    const history = (await storage.getHistory()).slice(0, 20);
    const table = $('historyTable');
    table.innerHTML = '';
    if (!history.length) {
      table.innerHTML = '<tr><td class="empty">No posts processed yet.</td></tr>';
      return;
    }
    table.innerHTML = '<tr><th>Time</th><th class="num">Invited</th><th class="num">Failed</th><th>End</th></tr>';
    for (const h of history) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td class="num"></td><td class="num"></td><td></td>';
      tr.children[0].textContent = fmtTime(h.time);
      tr.children[1].textContent = h.invited;
      tr.children[2].textContent = h.failed;
      tr.children[3].textContent = String(h.stoppedReason || '').replace(/_/g, ' ');
      tr.title = h.url || '';
      table.appendChild(tr);
    }
  }

  async function renderAll() {
    await renderCounters();
    renderControls();
  }

  // ---- settings form -------------------------------------------------------------

  const form = $('settingsForm');

  function fillForm(s) {
    for (const el of form.elements) {
      if (!el.name || !(el.name in s)) continue;
      if (el.type === 'checkbox') el.checked = !!s[el.name];
      else el.value = s[el.name];
      el.classList.remove('invalid');
    }
  }

  function readForm() {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return out;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await storage.saveSettings(readForm());
    const errs = $('formErrors');
    errs.innerHTML = '';
    for (const el of form.elements) el.classList && el.classList.remove('invalid');
    if (!res.ok) {
      for (const msg of res.errors) {
        const li = document.createElement('li');
        li.textContent = msg;
        errs.appendChild(li);
        const name = msg.split(' ')[0];
        if (form.elements[name]) form.elements[name].classList.add('invalid');
      }
      return;
    }
    settings = { ...storage.DEFAULTS, ...res.clean };
    fillForm(settings);
    $('savedMsg').hidden = false;
    setTimeout(() => ($('savedMsg').hidden = true), 1500);
    renderAll();
  });

  $('defaultsBtn').addEventListener('click', () => fillForm(storage.DEFAULTS));

  // ---- controls ------------------------------------------------------------------

  async function command(type, extra) {
    try {
      live = await send(type, extra);
    } catch (e) {
      connected = false;
      setStatus('Lost connection to the page. Refresh the Facebook tab and try again.', true);
    }
    await renderAll();
  }

  $('startBtn').addEventListener('click', () => command('START'));
  $('stopBtn').addEventListener('click', () => command('STOP'));
  $('pauseBtn').addEventListener('click', () => command(live && live.state === 'paused' ? 'RESUME' : 'PAUSE'));
  $('overrideBtn').addEventListener('click', () => {
    const ok = confirm(
      'Facebook recently warned about this activity.\n\n' +
      'Continuing before the cooldown ends makes it more likely that Facebook restricts ' +
      'the invite feature or your account.\n\nStart anyway?'
    );
    if (ok) command('START', { override: true });
  });

  $('resetStatsBtn').addEventListener('click', async () => {
    if (!confirm('Delete daily counters and post history? This also resets today’s count toward the daily limit.')) return;
    await storage.resetStats();
    await renderStats();
    await renderAll();
  });

  // ---- live updates --------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'STATE' || !sender.tab || sender.tab.id !== tabId) return;
    live = msg.state;
    connected = true;
    renderAll();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.cooldown) cooldown = await storage.getCooldown();
    if (changes.settings) settings = await storage.getSettings();
    if (changes.daily || changes.history) renderStats();
    renderAll();
  });

  // Keep the cooldown countdown fresh while the popup is open.
  setInterval(renderControls, 30000);

  // ---- init --------------------------------------------------------------------

  async function connect() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab ? tab.id : null;
    const url = (tab && tab.url) || '';
    if (!SUPPORTED.some((re) => re.test(url))) {
      connected = false;
      setStatus('Open a Facebook tab with your Page’s post, then open this popup again.');
      return;
    }
    try {
      live = await send('GET_STATE');
      connected = !!live && !live.error;
      if (!connected) setStatus('The page did not answer. Refresh the Facebook tab.', true);
    } catch (e) {
      connected = false;
      // "Receiving end does not exist": the tab was opened before the extension was
      // installed or reloaded, so it has no (or an orphaned) content script.
      setStatus('The extension was installed or reloaded after this tab was opened. Refresh the Facebook tab (F5), then try again.', true);
    }
  }

  (async () => {
    settings = await storage.getSettings();
    cooldown = await storage.getCooldown();
    fillForm(settings);
    await connect();
    await renderStats();
    await renderAll();
  })();
})();
