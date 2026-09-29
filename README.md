# FB Page Inviter (Phase 1: semi-automatic)

A Chrome extension (Manifest V3) that invites people who reacted to your Facebook Page's posts to like the Page. You open a post's reactions popup yourself. The extension then clicks **Invite** for each person, scrolls to load more people, and stops when the list runs out.

It only simulates clicks and scrolling on the page. It sends no network requests of its own and does not use Facebook's private APIs.

> **Risk warning.** Facebook limits how many invites you can send and may temporarily block the invite feature, or restrict the account, when it detects automated or very fast activity. Use conservative settings, stay well under the limits, and stop for the day if you see any warning. You use this extension at your own risk.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (the one that contains `manifest.json`).
3. Refresh any Facebook tabs that were already open. Content scripts are only injected into pages loaded after the install or reload.

## Use

1. On Facebook, switch to your Page profile and open one of its posts.
2. Click the reactions count (for example "👍 1.2K") to open the list of people who reacted.
3. Click the extension icon and press **Start**, or press **Start** on the floating panel in the bottom right.
4. The extension clicks Invite for each person with a short random delay between clicks and scrolls the popup's list to load more people. If you set a batch size, it also takes a break after each batch.
5. If no new people load for *Idle wait* seconds, the post is marked finished. If **Auto continue** is on, open the next post's reactions popup and it starts again by itself.

You can use **Pause/Resume** and **Stop** in the popup or the floating panel. Stop takes effect immediately. The extension also pauses on its own while the tab is hidden, and when the page URL changes during a run.

While a post is being processed, the page behind the popup is locked in place, so the feed doesn't scroll or start loading more posts. The lock is released as soon as the post finishes.

The defaults are fast: 0–1 s between clicks, no breaks and no limits. Warning detection is always on.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Min delay / Max delay (s) | 0 / 1 | Random wait between invite clicks. |
| Batch size | 0 | Number of invites before a break. 0 means no breaks. |
| Break min / max (s) | 60 / 120 | Random length of the break after each batch. |
| Daily limit | 0 | Maximum number of invites per calendar day, across all tabs and restarts. 0 means no limit. |
| Session limit | 0 | Maximum number of invites per session. A session runs from Start until Stop, a limit, or a block. 0 means no limit. |
| Idle wait (s) | 10 | How long to wait for new people after scrolling before the post counts as finished. |
| Block cooldown (h) | 24 | How long Start stays disabled after a Facebook warning. You can override this after confirming. |
| Invite button labels | `Invite` | Comma-separated button labels that mean "invite". Add your Facebook language, for example `Invite, Invitar, Inviter, Einladen`. Matching is exact and ignores case. |
| Close popup when finished | off | Closes the reactions popup after each finished post. |
| Auto continue | on | Starts automatically when a new reactions popup with Invite buttons opens. |
| Verbose console logs | off | Writes extra `[FBPI]` debug lines to the page console. |

### Recommended safe settings

The defaults are built for speed. If Facebook shows a warning, or for a new or small Page, switch to something like this:

- Min delay 6 s, max delay 15 s
- Batch size 25–30, breaks of 180–400 s
- Daily limit 100–150, session limit 60–100
- Build up slowly over several days, and don't run it around the clock.

## Safety features

- A random delay between clicks, plus a short random pause (0.05–0.15 s) after scrolling a button into view.
- Optional breaks after each batch, an optional daily limit (saved per local calendar day in `chrome.storage.local`, so it survives restarts), and an optional session limit. All three are off by default.
- **Block detection.** After every click, the extension scans new dialogs, alerts and toasts for phrases such as "try again later" or "you're going too fast". If it finds one, it stops at once, shows a red warning, and starts the cooldown.
- If 5 clicks in a row don't change the button, the extension stops. This usually means Facebook changed its layout.
- Only buttons labeled exactly *Invite* (or one of your labels) are clicked. Buttons that say *Invited*, *Liked*, *Following* and similar are ignored.

## Troubleshooting

| Problem | What to do |
|---|---|
| The popup says the extension was installed or reloaded after this tab was opened | Refresh the Facebook tab (F5). |
| "Open a post's likes popup first" | Open the reactions list of a post, not only the post. |
| Nothing gets clicked, or "Clicks are not working" | Your Invite button may use another word. Add it under **Invite button labels**. If that doesn't help, see the next section. |
| The page behind the popup still moves | Turn on **Verbose console logs**, press F12 and open the Console. Lines starting with `[FBPI] Page scroll blocked on` show which element scrolled. |
| Red "Blocked" message | Facebook showed a warning. Wait out the cooldown, or override it from the popup (not recommended). |

## When Facebook changes its layout

Every selector and text used to find Facebook elements is in `FB_CONFIG` at the top of [content/dom.js](content/dom.js):

- `dialogSelector` finds the popup layers (`[role="dialog"]`).
- `buttonSelector` finds clickable elements (`[role="button"], button`).
- `rowActionLabels` lists the button texts that mark a person row. A dialog counts as the reactions popup only if it contains one of these. Add your language here.
- `closeLabels` lists the aria-labels of a dialog's close button.
- `blockScanSelectors` and `blockPhrases` control where the extension looks for warnings and which phrases count as one. Add phrases in your language.

To inspect the current markup, open the reactions popup, right-click an Invite button and choose **Inspect**. Look for `role` and `aria-label` attributes, and prefer those over class names, which Facebook obfuscates and changes often. After editing, click the reload icon on the extension in `chrome://extensions` and refresh the Facebook tab. Turn on **Verbose console logs** to see what the extension finds.

## Testing with the mock page

`test/mock-likes.html` imitates a reactions popup. It starts with 15 rows and loads 15 more (after 1–3 s) each time you scroll to the bottom, up to 100. Rows show Invite, Invited, Liked or Following. Clicked Invite buttons change to Invited, except about 5% that fail on purpose. The page also has a button that shows a "Try Again Later" warning, and another that opens a different post.

1. Serve the folder over HTTP, for example with XAMPP: `http://localhost/autoinvite/test/mock-likes.html`
   (or `npx http-server -p 8080` in this folder and open `http://localhost:8080/test/mock-likes.html`).
2. Open the popup and press Start.

Query parameters: `?fast=1` loads faster, `?broken=1` makes Invite clicks do nothing, `?fail=0.2` sets the failure rate, `?max=40` sets the number of rows, and `?open=1` opens the popup on load.

### Test mode (removed)

This build runs on Facebook only, so the mock page won't work as shipped. To test with the mock page again, temporarily add a second object to `content_scripts` in `manifest.json` with `"matches": ["http://localhost/*", "http://127.0.0.1/*"]` and the same `js` list. Also add `/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//` to `SUPPORTED` in `popup.js`. Remove both again before real use.

## Architecture (for Phase 2)

```
content/storage.js  settings, daily counters, history, cooldown   -> FBPI.storage
content/dom.js      FB_CONFIG + all DOM lookups                   -> FBPI.dom
content/engine.js   invite loop, no UI/session knowledge          -> FBPI.engine
content/overlay.js  Shadow-DOM floating panel                     -> FBPI.overlay
content/main.js     controller: state, messaging, next-post watch -> FBPI.controller
background.js       toolbar badge only
popup.*             settings, controls, stats
```

The engine locks the page scroll itself while it runs (`FBPI.dom.lockPageScroll`). A future navigation module can call the engine directly:

```js
const result = await FBPI.engine.runOnDialog(dialog, {
  signal,                          // AbortController.signal
  gate: new FBPI.engine.PauseGate(),
  getSettings: () => settings,
  limits: { canInvite: async () => null /* or 'daily_limit' | 'session_limit' */ },
  onInvited: async () => FBPI.storage.incrementDaily(1),
  onEvent: (state, data) => {},
});
// result = { invited, failed, stoppedReason, durationMs, block? }
// stoppedReason: finished | user_stop | daily_limit | session_limit | blocked |
//                consecutive_failures | dialog_closed | navigation | error
```
