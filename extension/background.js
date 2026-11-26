// Watches network traffic for HLS playlists and remembers them per tab,
// scoring each one by evidence that it's the feed actually playing.
importScripts("scoring.js", "actions.js");

const MAX_PER_TAB = 15;

// A playlist is a link ending in .m3u8, or a response the server labels as one:
// some players load theirs from links without the extension (/playlist?id=…).
// Those are remembered by path, so their later reloads (and request headers) are
// caught before the response arrives, like .m3u8 links.
const PLAYLIST_TYPE_RE = /mpegurl/i;
const typedPlaylists = new Set();
const isPlaylistUrl = (url) => /\.m3u8/i.test(url) || typedPlaylists.has(feedKey(url));
function isPlaylistResponse(details) {
  if (isPlaylistUrl(details.url)) return true;
  const type = (details.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type");
  if (!type || !PLAYLIST_TYPE_RE.test(type.value || "")) return false;
  typedPlaylists.add(feedKey(details.url));
  return true;
}
const iconSet = (suffix) =>
  Object.fromEntries([16, 32, 48, 128].map((n) => [n, `icons/icon${n}${suffix}.png`]));
const ICONS_ON = iconSet("");
const ICONS_OFF = iconSet("-off");
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
  // Toolbar icon in colour while the tab has a working feed, grey otherwise.
  const found = streams.some((s) => !s.dead);
  chrome.action.setIcon({ tabId, path: found ? ICONS_ON : ICONS_OFF }).catch(() => {});
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

// Some players fetch their playlist through a service worker (P2P add-ons do),
// so the request belongs to no tab. Hand a tab-less playlist request to the
// handler as if the frame whose origin started it had made it.
function withTab(isPlaylist, handler) {
  return (details) => {
    if (details.tabId >= 0) return handler(details);
    if (!details.initiator || !isPlaylist(details)) return;
    frameForOrigin(details.initiator).then((f) => f && handler({ ...details, ...f }));
  };
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return ""; } };
const framesByOrigin = new Map(); // origin -> { tabId, frameId, documentId }
chrome.webNavigation.onCommitted.addListener((d) => {
  const origin = originOf(d.url);
  if (origin && origin !== "null") framesByOrigin.set(origin, { tabId: d.tabId, frameId: d.frameId, documentId: d.documentId });
});

async function frameForOrigin(origin) {
  const known = framesByOrigin.get(origin);
  if (known) {
    const f = await chrome.webNavigation.getFrame({ tabId: known.tabId, frameId: known.frameId }).catch(() => null);
    if (f && originOf(f.url) === origin) return { ...known, documentId: f.documentId || known.documentId };
    framesByOrigin.delete(origin);
  }
  // The worker slept and forgot: look through the open tabs.
  for (const tab of await chrome.tabs.query({})) {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null)) || [];
    const f = frames.find((x) => originOf(x.url) === origin);
    if (f) {
      const found = { tabId: tab.id, frameId: f.frameId, documentId: f.documentId };
      framesByOrigin.set(origin, found);
      return found;
    }
  }
  return null;
}

// Playlist loaded successfully: count it.
chrome.webRequest.onCompleted.addListener(
  withTab(isPlaylistResponse, (details) => {
    if (details.tabId < 0) return;
    if (isPlaylistResponse(details)) {
      tabsWithStreams.add(details.tabId);
      update(details.tabId, (streams) => {
        const s = findOrAdd(streams, details);
        const now = Date.now();
        s.time = now;
        if (details.statusCode >= 200 && details.statusCode < 400) {
          forwardFreshLink(details.tabId, details.url);
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
        // A couple of chunks in, the video is really playing: the site's automatic action.
        if (match.segs >= 2) autoAct(details.tabId, match);
      });
    }
  }),
  { urls: ["<all_urls>"], types: REQUEST_TYPES },
  ["responseHeaders"]
);

// The popup marks feeds the helper found to be image-disguised ("browser only").
// Done here so it goes through the same per-tab queue as network updates.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "popOut") {
    sendResponse({ ok: true }); // the popup closes as soon as the new window takes focus
    openPopout(msg).catch((e) => console.warn("pop-out failed", e));
    return;
  }
  if (msg && msg.type === "recordNetwork") {
    startRecording(msg.tabId);
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "networkSummary") {
    networkSummary(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg && msg.type === "recordingTab") {
    sendResponse({ tabId: recording && Date.now() < recording.until ? recording.tabId : null });
    return;
  }
  if (msg && msg.type === "followFeed") {
    followFeed(msg);
    return;
  }
  if (msg && msg.type === "popoutFullscreen" && sender.tab) {
    onPopoutFullscreenEvent(sender, msg.event);
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
  withTab((d) => isPlaylistUrl(d.url), (details) => {
    if (details.tabId < 0 || !isPlaylistUrl(details.url)) return;
    const headers = (details.requestHeaders || [])
      .filter((h) => h.value != null && !SKIP_HEADERS.test(h.name))
      .map((h) => [h.name, h.value]);
    tabsWithStreams.add(details.tabId);
    update(details.tabId, (streams) => {
      const s = findOrAdd(streams, details);
      if (JSON.stringify(s.headers) === JSON.stringify(headers)) return false;
      s.headers = headers;
    });
  }),
  { urls: ["<all_urls>"], types: REQUEST_TYPES },
  ["requestHeaders", "extraHeaders"]
);

// Playlist failed to load (timeout, DNS, connection refused): mark dead.
chrome.webRequest.onErrorOccurred.addListener(
  withTab((d) => isPlaylistUrl(d.url), (details) => {
    if (details.tabId < 0 || !isPlaylistUrl(details.url)) return;
    tabsWithStreams.add(details.tabId);
    update(details.tabId, (streams) => {
      findOrAdd(streams, details).dead = true;
    });
  }),
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
  unfollowFeeds(tabId);
});

// ---- Fresh links for open mpv windows ----
// Many feeds carry a token that expires after a few minutes; the page's player
// keeps fetching the playlist with new tokens, but mpv only has the link it was
// launched with. While the tab stays open, forward each new link for a feed
// playing in mpv to the helper, which hands it to that window's reload script.
const FOLLOWED_KEY = "followedFeeds";
// Same feed = same playlist path; the query (token) and edge server may change.
const feedKey = (url) => { try { return new URL(url).pathname; } catch { return url; } };

async function getFollowed() {
  return (await chrome.storage.session.get(FOLLOWED_KEY))[FOLLOWED_KEY] || {};
}

async function followFeed({ tabId, url, session }) {
  const followed = await getFollowed();
  // One mpv window per feed: a new launch of the same feed replaces the old one.
  const others = (followed[tabId] || []).filter((f) => f.key !== feedKey(url));
  followed[tabId] = [...others, { session, key: feedKey(url), url }];
  await chrome.storage.session.set({ [FOLLOWED_KEY]: followed });
}

async function unfollowFeeds(tabId) {
  const followed = await getFollowed();
  if (!(tabId in followed)) return;
  delete followed[tabId];
  await chrome.storage.session.set({ [FOLLOWED_KEY]: followed });
}

async function forwardFreshLink(tabId, url) {
  const followed = await getFollowed();
  const feed = (followed[tabId] || []).find((f) => f.key === feedKey(url));
  if (!feed || feed.url === url) return;
  feed.url = url;
  await chrome.storage.session.set({ [FOLLOWED_KEY]: followed });
  chrome.runtime.sendNativeMessage(HOST, { action: "refresh", session: feed.session, url })
    .catch((e) => console.warn("couldn't pass fresh link to mpv", e));
}

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

async function openPopout({ src, ref, page, pageRef = "", autoplay = true, fullscreen = true }) {
  if (!/^https?:/i.test(src)) return;
  const win = await chrome.windows.create(
    fullscreen
      ? { url: "about:blank", type: "popup", state: "fullscreen" }
      : { url: "about:blank", type: "popup", width: 1024, height: 576 }
  );
  const tabId = win.tabs[0].id;
  await setPopoutRules(tabId, src, ref);
  const popouts = await getPopouts();
  // windowFullscreen: the window is in the fullscreen *we* set (not the player's).
  // fallback: the page holding the player, for when it won't run on its own
  // (popoutTarget in actions.js), requested with fallbackRef as Referer.
  const fallback = page && page !== src && /^https?:/i.test(page) ? page : null;
  // openedAt: a player refusing to run on its own redirects within seconds of
  // opening (see the onCommitted and onErrorOccurred listeners below).
  popouts[tabId] = { src, autoplay, windowFullscreen: fullscreen, fallback, fallbackRef: pageRef, openedAt: Date.now() };
  await chrome.storage.session.set({ [POPOUTS_KEY]: popouts });
  await chrome.tabs.update(tabId, { url: src });
  return win.id;
}

async function setPopoutRules(tabId, src, ref) {
  const host = new URL(src).hostname;
  const hosts = [...new Set([host, host.replace(/^www\./, "")])];
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
}

// Some players only serve the real page inside their site's iframe and show a
// placeholder ("Hello World", a blank page) when opened on their own. If the
// pop-out still has no video or frame a while after loading, and isn't fetching a
// stream either, show the whole page instead. Players often show a splash screen
// for a few seconds first, so keep looking rather than checking once.
const PLAYER_WAIT_MS = 10000;
async function checkPopoutPlayer(tabId) {
  const startSrc = (await getPopouts())[tabId]?.src;
  const [{ result: hasPlayer } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (ms) => new Promise((done) => {
      const deadline = Date.now() + ms;
      const look = () => {
        if (document.querySelector("video, iframe, embed, object")) return done(true);
        if (Date.now() > deadline) return done(false);
        setTimeout(look, 500);
      };
      look();
    }),
    args: [PLAYER_WAIT_MS],
  }).catch(() => []);
  const popouts = await getPopouts();
  const popout = popouts[tabId];
  // Left alone if the page moved on meanwhile (its own load runs a new check).
  if (hasPlayer !== false || !popout?.fallback || popout.src !== startSrc) return;
  if ((await getStreams(tabId)).some((s) => !s.dead)) return;
  await useFallback(tabId, popouts);
}

// Show the page holding the player in the pop-out, with the player stretched over it.
async function useFallback(tabId, popouts) {
  const popout = popouts[tabId];
  const page = popout.fallback;
  popout.player = popout.src; // the player frame, to fit to the window (fitPlayer)
  popout.src = page;
  popout.fallback = null;
  await chrome.storage.session.set({ [POPOUTS_KEY]: popouts });
  await setPopoutRules(tabId, page, popout.fallbackRef || "");
  chrome.tabs.update(tabId, { url: page }).catch(() => {});
}

// Right after opening, a player that refuses to run on its own often sends the
// window elsewhere on its own site (homepage, login), which the off-site block
// doesn't catch: show the page holding it instead.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const popouts = await getPopouts();
  const popout = popouts[details.tabId];
  if (!popout?.fallback || Date.now() - (popout.openedAt || 0) > EARLY_REDIRECT_MS) return;
  const sameDoc = (a, b) => a.split("#")[0] === b.split("#")[0];
  if (/^https?:/i.test(details.url) && !sameDoc(details.url, popout.src)) useFallback(details.tabId, popouts);
});

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

// Once each page or frame in a pop-out finishes loading: watch for Esc (always),
// and start its video (if auto-play is on).
chrome.webNavigation.onCompleted.addListener(async (details) => {
  const popout = (await getPopouts())[details.tabId];
  if (!popout) return;
  const target = { tabId: details.tabId, frameIds: [details.frameId] };
  chrome.scripting.executeScript({ target, func: watchFullscreen }).catch(() => {});
  if (popout.autoplay) chrome.scripting.executeScript({ target, func: startPlayback }).catch(() => {});
  if (details.frameId === 0 && popout.fallback) checkPopoutPlayer(details.tabId);
  if (popout.player) fitPlayer(details.tabId, popout.player);
});

// The pop-out can be fullscreen two ways: the window fullscreen we set when opening
// it, and the player's own fullscreen. They look identical, so while ours is on,
// treat them as one: Esc, double-click or the player's fullscreen button all leave
// fullscreen in one step. Once out, the player's fullscreen behaves normally.
// (A window made fullscreen by an extension also ignores Esc on its own — the
// browser hands the key to the page — hence the Esc listener.)
function watchFullscreen() {
  if (window.__playInMpvFullscreen) return;
  window.__playInMpvFullscreen = true;
  const send = (event) => chrome.runtime.sendMessage({ type: "popoutFullscreen", event }).catch(() => {});
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.fullscreenElement) send("escape");
  }, true);
  document.addEventListener("fullscreenchange", () => {
    send(document.fullscreenElement ? "playerEntered" : "playerExited");
  });
}

async function onPopoutFullscreenEvent(sender, event) {
  const popouts = await getPopouts();
  const popout = popouts[sender.tab.id];
  if (!popout || !popout.windowFullscreen) return; // not ours: let the player handle it
  popout.windowFullscreen = false;
  await chrome.storage.session.set({ [POPOUTS_KEY]: popouts });
  if (event === "playerEntered") {
    // Already looked fullscreen, so this was meant as "leave": undo the player's too.
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, allFrames: true },
      func: () => document.fullscreenElement && document.exitFullscreen().catch(() => {}),
    }).catch(() => {});
  }
  await chrome.windows.update(sender.tab.windowId, { state: "normal" });
  chrome.windows.update(sender.tab.windowId, { width: 1024, height: 576 }).catch(() => {});
}

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

// A blocked navigation leaves an error page in the window. Right after opening,
// it's the player refusing to run outside its site and sending the window to its
// own homepage or login: show the whole page instead (or, for a pop-out that is
// already the whole page, follow it once). Later, it's an ad hijacking a click:
// put the player back. If the player keeps redirecting off-site, restoring would
// loop, so give up when it happens again within a few seconds.
const EARLY_REDIRECT_MS = 10000;
const lastRestore = {};
chrome.webNavigation.onErrorOccurred.addListener(async (details) => {
  if (details.frameId !== 0 || !/BLOCKED_BY_CLIENT/.test(details.error)) return;
  const popouts = await getPopouts();
  const popout = popouts[details.tabId];
  if (!popout?.src) return;
  const now = Date.now();
  if (now - (popout.openedAt || 0) < EARLY_REDIRECT_MS) {
    if (popout.fallback) return useFallback(details.tabId, popouts);
    if (!popout.followed && !popout.player && /^https?:/i.test(details.url)) {
      // Sent from the page that redirected, like the browser would.
      const from = popout.src;
      popout.followed = true;
      popout.src = details.url;
      await chrome.storage.session.set({ [POPOUTS_KEY]: popouts });
      await setPopoutRules(details.tabId, details.url, from);
      chrome.tabs.update(details.tabId, { url: details.url }).catch(() => {});
      return;
    }
  }
  if (now - (lastRestore[details.tabId] || 0) < 5000) return;
  lastRestore[details.tabId] = now;
  chrome.tabs.update(details.tabId, { url: popout.src }).catch(() => {});
});

// ---- Fitting the player to a fallen-back pop-out ----
// When the pop-out shows the whole page, make the player fill the window: in each
// frame from the top page down to the player, the iframe leading to it is stretched
// over the whole viewport. Runs again as each frame loads, so nested players that
// load late are fitted too.
async function fitPlayer(tabId, playerUrl) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (!frames) return;
  const key = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };
  let frame = frames.find((f) => f.url === playerUrl) || frames.find((f) => key(f.url) === key(playerUrl));
  while (frame && frame.parentFrameId >= 0) {
    const parent = frames.find((f) => f.frameId === frame.parentFrameId);
    if (!parent) break;
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [parent.frameId] }, func: fillWithFrame, args: [frame.url],
    }).catch(() => {});
    frame = parent;
  }
}

// Runs inside a page: stretch the iframe showing childUrl (or, failing a match,
// the biggest iframe) over the whole viewport.
function fillWithFrame(childUrl) {
  const key = (u) => { try { const x = new URL(u, location.href); return x.origin + x.pathname; } catch { return u; } };
  const iframes = [...document.querySelectorAll("iframe")];
  const area = (f) => f.clientWidth * f.clientHeight;
  const target = iframes.find((f) => f.src === childUrl) || iframes.find((f) => key(f.src) === key(childUrl)) ||
    iframes.sort((a, b) => area(b) - area(a))[0];
  if (!target) return;
  if (!document.getElementById("play-in-mpv-fill")) {
    const style = document.createElement("style");
    style.id = "play-in-mpv-fill";
    style.textContent = `
      html, body { overflow: hidden !important; }
      [data-play-in-mpv-fill] { position: fixed !important; inset: 0 !important; width: 100vw !important;
        height: 100vh !important; max-width: none !important; max-height: none !important; margin: 0 !important;
        border: 0 !important; transform: none !important; z-index: 2147483647 !important; background: #000 !important; }`;
    (document.head || document.documentElement).append(style);
  }
  document.querySelectorAll("[data-play-in-mpv-fill]").forEach((f) => f !== target && f.removeAttribute("data-play-in-mpv-fill"));
  target.setAttribute("data-play-in-mpv-fill", "");
}

// ---- Per-site automatic action ----
// On sites the user picked in the popup, open the video in the pop-out or the
// external player as soon as it starts playing. If the player can't take the
// feed, fall back to the pop-out. Once per feed: sites often switch streams by
// loading a new player into a frame without reloading the page, so a different
// playlist triggers it again, while the same one (a player reloading itself, a
// fresh token) doesn't. Reloading the page starts over.
const AUTO_KEY = "autoHandled";
const AUTO_WINDOWS_KEY = "autoPopoutWindows";
const autoBusy = new Set();

async function autoAct(tabId, stream) {
  if (autoBusy.has(tabId)) return;
  autoBusy.add(tabId);
  try {
    const handled = (await chrome.storage.session.get(AUTO_KEY))[AUTO_KEY] || {};
    if (handled[tabId] === feedKey(stream.url)) return;
    const prefs = await getPrefs();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const action = tab && prefs.siteActions[siteKey(tab.url)];
    if (!action) return;
    if (String(tabId) in (await getPopouts())) return; // a pop-out is already the result
    handled[tabId] = feedKey(stream.url);
    await chrome.storage.session.set({ [AUTO_KEY]: handled });

    if (action === "player") {
      const res = await launchFeed(tab, stream, { player: prefs.player, autoReload: prefs.autoReload });
      if (res.ok) {
        if (res.session) await followFeed({ tabId, url: stream.url, session: res.session });
        if (prefs.pauseOriginal) pauseVideos(tabId);
        return;
      }
      console.warn("auto-play in external player failed, using the pop-out:", res.error);
      if (res.browserOnly) {
        update(tabId, (streams) => {
          const s = streams.find((x) => x.url === stream.url);
          if (!s) return false;
          s.browserOnly = true;
        });
      }
    }
    const target = await popoutTarget(tab, stream);
    if (prefs.pauseOriginal) await pauseVideos(tabId);
    // A new stream replaces the pop-out this tab opened automatically before.
    const windows = (await chrome.storage.session.get(AUTO_WINDOWS_KEY))[AUTO_WINDOWS_KEY] || {};
    if (windows[tabId] != null) chrome.windows.remove(windows[tabId]).catch(() => {});
    const winId = await openPopout({ ...target, autoplay: prefs.popoutAutoplay, fullscreen: prefs.popoutFullscreen });
    if (winId != null) {
      windows[tabId] = winId;
      await chrome.storage.session.set({ [AUTO_WINDOWS_KEY]: windows });
    }
  } catch (e) {
    console.warn("automatic action failed", e);
  } finally {
    autoBusy.delete(tabId);
  }
}

async function forgetAutoHandled(tabId) {
  const handled = (await chrome.storage.session.get(AUTO_KEY))[AUTO_KEY] || {};
  if (!(tabId in handled)) return;
  delete handled[tabId];
  await chrome.storage.session.set({ [AUTO_KEY]: handled });
}

// A new page (or a reload) in the tab gets its own automatic action.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) forgetAutoHandled(details.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => forgetAutoHandled(tabId));

// ---- Network summary (popup's "Record network summary") ----
// For working out how a player the extension can't detect loads its video: on
// request, record one tab's requests (plus tab-less ones, e.g. from workers) for a
// few minutes, then hand them to the popup to copy. Off unless started, so the
// worker isn't woken by every request on every page.
const RECORD_MS = 5 * 60 * 1000;
const RECORD_MAX = 600;
let recording = null; // { tabId, until, requests }

function recordRequest(d) {
  if (!recording || Date.now() > recording.until) return stopRecording();
  if (d.tabId !== recording.tabId && d.tabId >= 0) return;
  const type = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type");
  recording.requests.push({ time: d.timeStamp, tabId: d.tabId, frameId: d.frameId, type: d.type, status: d.statusCode,
    contentType: type ? type.value : "", initiator: d.initiator || "", url: d.url.slice(0, 300) });
  if (recording.requests.length > RECORD_MAX) recording.requests.shift();
}

function startRecording(tabId, until = Date.now() + RECORD_MS) {
  stopRecording();
  recording = { tabId, until, requests: [] };
  // Kept in session storage too: the worker can sleep before the video starts,
  // and listeners added at runtime don't wake it; the next startup resumes.
  chrome.storage.session.set({ recording: { tabId, until } });
  // One unfiltered listener (recordRequest keeps this tab's and tab-less requests):
  // a tabId filter can't also take tab-less requests, and -1 means any tab.
  chrome.webRequest.onCompleted.addListener(recordRequest, { urls: ["<all_urls>"] }, ["responseHeaders"]);
}

function stopRecording() {
  while (chrome.webRequest.onCompleted.hasListener(recordRequest)) {
    chrome.webRequest.onCompleted.removeListener(recordRequest);
  }
  if (recording && Date.now() > recording.until) {
    recording = null;
    chrome.storage.session.remove("recording");
  }
}

chrome.storage.session.get("recording").then(({ recording: r }) => {
  if (r && Date.now() < r.until && !recording) startRecording(r.tabId, r.until);
});

async function networkSummary(tabId) {
  const requests = recording && recording.tabId === tabId ? recording.requests : [];
  const frames = (await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)) || [];
  const origins = new Set(frames.map((f) => { try { return new URL(f.url).origin; } catch { return ""; } }).filter(Boolean));
  const lines = frames.map((f) => `frame ${f.frameId} (parent ${f.parentFrameId}): ${f.url.slice(0, 200)}`);
  const start = requests[0] ? requests[0].time : 0;
  for (const r of requests) {
    if (r.tabId < 0 && !origins.has(r.initiator)) continue;
    lines.push([`+${((r.time - start) / 1000).toFixed(1)}s`, r.tabId < 0 ? `no-tab(${r.initiator})` : `f${r.frameId}`, r.type, r.status,
      r.contentType.split(";")[0] || "-", r.url].join(" "));
  }
  return { text: lines.join("\n"), count: requests.length };
}
