// Watches network traffic for .m3u8 playlists and remembers them per tab,
// scoring each one by evidence that it's the feed actually playing.
importScripts("scoring.js");

const MAX_PER_TAB = 15;
const SEGMENT_RE = /\.(ts|m4s|m4v|m4a|aac|mp4|fmp4)(\?|$)/i;

// Only these request types can carry playlists or chunks: XHR/fetch (HLS players),
// media (native <video>), other, and frames (an .m3u8 opened directly).
// Skipping images, scripts, CSS and fonts keeps the worker asleep on most pages.
const REQUEST_TYPES = ["xmlhttprequest", "media", "other", "main_frame", "sub_frame"];

// Tabs that have seen a playlist. Chunk events for any other tab are ignored
// without touching storage.
const tabsWithStreams = new Set();

// The worker sleeps and loses memory, so rebuild the set from session storage on
// startup. Chunk events that arrive before this finishes are skipped; live
// playlists reload every few seconds, so the tab is re-added almost immediately.
const rebuilt = chrome.storage.session.get(null).then((all) => {
  for (const [key, streams] of Object.entries(all)) {
    if (key.startsWith("tab_") && Array.isArray(streams) && streams.length) {
      tabsWithStreams.add(Number(key.slice(4)));
    }
  }
});

async function getStreams(tabId) {
  const key = `tab_${tabId}`;
  const data = await chrome.storage.session.get(key);
  return data[key] || [];
}

async function setStreams(tabId, streams) {
  await chrome.storage.session.set({ [`tab_${tabId}`]: streams });
  const n = streams.filter((s) => !s.dead).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#2e7d32" });
}

// Serialise updates per tab so rapid requests don't overwrite each other.
const queues = {};
function update(tabId, fn) {
  queues[tabId] = (queues[tabId] || Promise.resolve()).then(async () => {
    const streams = await getStreams(tabId);
    if (fn(streams) !== false) {
      streams.sort((a, b) => b.time - a.time);
      await setStreams(tabId, streams.slice(0, MAX_PER_TAB));
    }
  });
}

function findOrAdd(streams, details) {
  let s = streams.find((x) => x.url === details.url);
  if (!s) {
    s = { url: details.url, initiator: details.initiator || "", time: Date.now(), hits: 0, segs: 0, dead: false,
          score: 0, scoreAt: 0, lastLoad: null, lastActive: null };
    streams.push(s);
  }
  // Which frame document loaded it: lets us drop links from players that were
  // replaced (feed switched in an iframe) and keep chunk credit per player.
  if (details.documentId) s.documentId = details.documentId;
  if (details.frameId != null) s.frameId = details.frameId;
  return s;
}

// Playlist loaded successfully: count it.
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (/\.m3u8/i.test(details.url)) {
      tabsWithStreams.add(details.tabId);
      update(details.tabId, (streams) => {
        const s = findOrAdd(streams, details);
        const now = Date.now();
        s.time = now;
        if (details.statusCode >= 200 && details.statusCode < 400) {
          s.hits++;
          s.dead = false;
          s.lastLoad = now;
          addScore(s, PLAYLIST_WEIGHT, now);
        } else {
          s.dead = true;
        }
      });
    } else if (!tabsWithStreams.has(details.tabId)) {
      return;
    } else if ((SEGMENT_RE.test(details.url) || details.type === "xmlhttprequest") && details.statusCode < 400) {
      // Players fetch chunks via XHR/fetch; some sites disguise them as .png/.jpg,
      // so any XHR from a known playlist's server counts.
      // A video chunk downloaded: credit the playlist it most likely belongs to
      // (see matchChunk in scoring.js).
      update(details.tabId, (streams) => {
        const now = Date.now();
        const match = matchChunk(streams, details.url, now, details.documentId);
        if (!match) return false;
        match.segs++;
        match.time = now;
        addScore(match, CHUNK_WEIGHT, now);
      });
    }
  },
  { urls: ["<all_urls>"], types: REQUEST_TYPES }
);

// The popup marks feeds the helper found to be image-disguised ("browser only").
// Done here so it goes through the same per-tab queue as network updates.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "popOut") {
    sendResponse({ ok: true }); // the popup closes as soon as the new window takes focus
    openPopout(msg).catch((e) => console.warn("pop-out failed", e));
    return;
  }
  if (msg && msg.type === "browserOnly") {
    update(msg.tabId, (streams) => {
      const s = streams.find((x) => x.url === msg.url);
      if (!s) return false;
      s.browserOnly = true;
    });
  }
});

// Record the exact headers the browser sent for each playlist. Many streams check
// a cookie or a token header added by the site's player; mpv must send the same.
// "extraHeaders" is needed to see Cookie, Referer and Origin.
const SKIP_HEADERS = /^(host|connection|content-length|accept-encoding|range|priority|pragma|cache-control|upgrade-insecure-requests|if-.*|sec-.*)$/i;
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0 || !/\.m3u8/i.test(details.url)) return;
    const headers = (details.requestHeaders || [])
      .filter((h) => h.value != null && !SKIP_HEADERS.test(h.name))
      .map((h) => [h.name, h.value]);
    tabsWithStreams.add(details.tabId);
    update(details.tabId, (streams) => {
      const s = findOrAdd(streams, details);
      if (JSON.stringify(s.headers) === JSON.stringify(headers)) return false;
      s.headers = headers;
    });
  },
  { urls: ["<all_urls>"], types: REQUEST_TYPES },
  ["requestHeaders", "extraHeaders"]
);

// Playlist failed to load (timeout, DNS, connection refused): mark dead.
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.tabId < 0 || !/\.m3u8/i.test(details.url)) return;
    tabsWithStreams.add(details.tabId);
    update(details.tabId, (streams) => {
      findOrAdd(streams, details).dead = true;
    });
  },
  { urls: ["<all_urls>"], types: REQUEST_TYPES }
);

// A frame loaded a new document (e.g. the site swapped the player iframe to
// another feed without reloading the page): forget that frame's old links.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  await rebuilt;
  if (!tabsWithStreams.has(details.tabId)) return;
  update(details.tabId, (streams) => {
    const before = streams.length;
    const kept = streams.filter((s) => !(s.frameId === details.frameId && s.documentId && s.documentId !== details.documentId));
    if (kept.length === before) return false;
    streams.length = 0;
    streams.push(...kept);
  });
});

// Forget streams when the tab navigates to a new page or closes.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  // Only tabs that had streams have anything to clear. Wait for the rebuild so a
  // navigation that wakes the worker doesn't leave the old page's streams behind.
  await rebuilt;
  if (!tabsWithStreams.delete(tabId)) return;
  setStreams(tabId, []);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabsWithStreams.delete(tabId);
  chrome.storage.session.remove(`tab_${tabId}`);
  forgetPopout(tabId);
});

// ---- Pop-out player windows ----
// A pop-out is a normal popup window showing only the player's own page, so Brave
// Shields apply as usual. For that window only (session rules keyed by tab id):
//  - requests for the player page carry the embedding page as Referer, since
//    embeds often refuse to load without it;
//  - navigating the window to any other site is blocked (click-hijack ads), and
//    the player is put back;
// and any tab or window the player tries to open is closed (pop-up ads).
const POPOUTS_KEY = "popouts";
const popoutRuleIds = (tabId) => [tabId * 2 + 1, tabId * 2 + 2];

async function getPopouts() {
  return (await chrome.storage.session.get(POPOUTS_KEY))[POPOUTS_KEY] || {};
}

async function openPopout({ src, ref, autoplay = true, fullscreen = true }) {
  if (!/^https?:/i.test(src)) return;
  const host = new URL(src).hostname;
  const hosts = [...new Set([host, host.replace(/^www\./, "")])];
  const win = await chrome.windows.create(
    fullscreen
      ? { url: "about:blank", type: "popup", state: "fullscreen" }
      : { url: "about:blank", type: "popup", width: 1024, height: 576 }
  );
  const tabId = win.tabs[0].id;
  const [refRule, blockRule] = popoutRuleIds(tabId);
  const addRules = [{
    id: blockRule,
    priority: 2,
    action: { type: "block" },
    condition: { tabIds: [tabId], resourceTypes: ["main_frame"], excludedRequestDomains: hosts },
  }];
  if (ref && /^https?:/i.test(ref)) {
    addRules.push({
      id: refRule,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: ref }] },
      condition: { tabIds: [tabId], resourceTypes: ["main_frame"], requestDomains: hosts },
    });
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: popoutRuleIds(tabId), addRules });
  const popouts = await getPopouts();
  popouts[tabId] = { src, autoplay };
  await chrome.storage.session.set({ [POPOUTS_KEY]: popouts });
  await chrome.tabs.update(tabId, { url: src });
}

async function forgetPopout(tabId) {
  const popouts = await getPopouts();
  if (!(tabId in popouts)) return;
  delete popouts[tabId];
  await chrome.storage.session.set({ [POPOUTS_KEY]: popouts });
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: popoutRuleIds(tabId) }).catch(() => {});
}

// Pop-up ads: close any tab/window opened from a pop-out.
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  if (String(details.sourceTabId) in (await getPopouts())) chrome.tabs.remove(details.tabId).catch(() => {});
});
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId != null && String(tab.openerTabId) in (await getPopouts())) {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
});

// Auto-play: once each page or frame in a pop-out finishes loading, start its video.
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (!(await getPopouts())[details.tabId]?.autoplay) return;
  chrome.scripting.executeScript({
    target: { tabId: details.tabId, frameIds: [details.frameId] },
    func: startPlayback,
  }).catch(() => {});
});

// Runs inside the player page. Players often build the <video> late or wait for a
// click on their big play button, so retry for a while. If the browser blocks
// sound without a click, fall back to muted playback (one click unmutes).
function startPlayback() {
  const PLAY_BUTTONS = [
    ".jw-icon-display", ".vjs-big-play-button", ".plyr__control--overlaid", ".fp-play",
    "[class*='big-play']", "[class*='play-button']", "button[aria-label*='play' i]",
  ].join(",");
  const deadline = Date.now() + 20000;
  let clicks = 0;
  const biggestVideo = () =>
    [...document.querySelectorAll("video")].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  const timer = setInterval(() => {
    const video = biggestVideo();
    if ((video && !video.paused) || Date.now() > deadline) return clearInterval(timer);
    if (video && (video.currentSrc || video.src)) {
      video.play().catch((e) => {
        if (e.name === "NotAllowedError") {
          video.muted = true;
          video.play().catch(() => {});
        }
      });
    } else if (clicks < 3) {
      const button = document.querySelector(PLAY_BUTTONS);
      if (button) {
        clicks++;
        button.click();
      }
    }
  }, 1000);
}

// A blocked navigation leaves an error page in the window: put the player back.
// If the player itself redirects off-site, restoring would loop, so give up when
// it happens again within a few seconds.
const lastRestore = {};
chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.frameId !== 0 || !/BLOCKED_BY_CLIENT/.test(details.error)) return;
  const src = (await getPopouts())[details.tabId]?.src;
  if (!src) return;
  const now = Date.now();
  if (now - (lastRestore[details.tabId] || 0) < 5000) return;
  lastRestore[details.tabId] = now;
  chrome.tabs.update(details.tabId, { url: src }).catch(() => {});
});
