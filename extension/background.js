// Watches network traffic for .m3u8 playlists and remembers them per tab,
// scoring each one by evidence that it's the feed actually playing.
const MAX_PER_TAB = 15;
const SEGMENT_RE = /\.(ts|m4s|m4v|m4a|aac|mp4|fmp4)(\?|$)/i;

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

function dirOf(url) {
  const u = new URL(url);
  return u.origin + u.pathname.replace(/[^/]*$/, "");
}

function findOrAdd(streams, details) {
  let s = streams.find((x) => x.url === details.url);
  if (!s) {
    s = { url: details.url, initiator: details.initiator || "", time: Date.now(), hits: 0, segs: 0, dead: false };
    streams.push(s);
  }
  return s;
}

// Playlist loaded successfully: count it.
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (/\.m3u8/i.test(details.url)) {
      update(details.tabId, (streams) => {
        const s = findOrAdd(streams, details);
        s.time = Date.now();
        if (details.statusCode >= 200 && details.statusCode < 400) {
          s.hits++;
          s.dead = false;
        } else {
          s.dead = true;
        }
      });
    } else if ((SEGMENT_RE.test(details.url) || details.type === "xmlhttprequest") && details.statusCode < 400) {
      // Players fetch chunks via XHR/fetch; some sites disguise them as .png/.jpg,
      // so any XHR from a known playlist's server counts.
      // A video chunk downloaded: credit the playlist it most likely belongs to
      // (same folder first, then same server).
      update(details.tabId, (streams) => {
        if (!streams.length) return false;
        const dir = dirOf(details.url);
        const origin = new URL(details.url).origin;
        const match =
          streams.find((s) => dir.startsWith(dirOf(s.url))) ||
          streams.find((s) => new URL(s.url).origin === origin);
        if (!match) return false;
        match.segs++;
        match.time = Date.now();
      });
    }
  },
  { urls: ["<all_urls>"] }
);

// Playlist failed to load (timeout, DNS, connection refused): mark dead.
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.tabId < 0 || !/\.m3u8/i.test(details.url)) return;
    update(details.tabId, (streams) => {
      findOrAdd(streams, details).dead = true;
    });
  },
  { urls: ["<all_urls>"] }
);

// Forget streams when the tab navigates to a new page or closes.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) setStreams(tabId, []);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab_${tabId}`);
});
