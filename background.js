// FB Page Inviter - service worker. Only keeps the toolbar badge in sync with
// today's invite count. Daily counters are keyed by date, so no reset job is needed.
'use strict';

function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function updateBadge(stateHint) {
  const { daily = {}, cooldown } = await chrome.storage.local.get(['daily', 'cooldown']);
  const count = daily[todayKey()] || 0;
  const blocked = (cooldown && cooldown.until > Date.now()) || (stateHint && stateHint.state === 'blocked');
  await chrome.action.setBadgeText({ text: blocked ? '!' : count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: blocked ? '#d32f2f' : '#1877f2' });
}

chrome.runtime.onInstalled.addListener(() => updateBadge());
chrome.runtime.onStartup.addListener(() => updateBadge());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.daily || changes.cooldown)) updateBadge();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'STATE' && (msg.state.state === 'blocked' || msg.state.state === 'running')) {
    updateBadge(msg.state);
  }
});
