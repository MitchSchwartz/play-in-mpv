// Launching a feed, shared by popup.js (buttons) and background.js (per-site
// automatic actions).

const HOST = "local.play_in_mpv";

// The settings the popup's checkboxes and menus remember, with their defaults.
async function getPrefs() {
  return chrome.storage.local.get({
    autoReload: true,
    player: "mpv",
    pauseOriginal: true,
    popoutAutoplay: true,
    popoutFullscreen: true,
    siteActions: {},
  });
}

// Per-site automatic action, keyed by the tab's host without "www.".
const siteKey = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
};

// Ask the helper to play one feed. It checks the feed's first chunk and refuses
// (browserOnly) if the video is hidden in images, without opening a player.
// session names the mpv window, so fresh links for the feed can reach it later
// (followFeed in background.js).
async function launchFeed(tab, stream, { player, autoReload }) {
  const session = crypto.randomUUID();
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST, {
      url: stream.url,
      session,
      referrer: stream.initiator ? stream.initiator + "/" : tab.url,
      origin: stream.initiator || "",
      userAgent: navigator.userAgent,
      title: tab.title || "Stream",
      autoReload,
      player,
      // Exact headers the browser sent for this playlist (cookies, tokens, referer).
      headers: stream.headers || null,
    });
    if (res && res.ok) res.session = player === "mpv" ? session : null;
    return res || { ok: false, error: "No response from helper" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Pause and mute the original page's videos, and keep them that way: players that
// are still starting up (as when a site's automatic action fires) call play() again
// right after a pause. The hold ends once the user clicks or presses a key on the page.
function pauseVideos(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const hush = (v) => { v.muted = true; v.pause(); };
      document.querySelectorAll("video").forEach(hush);
      if (window.__playInMpvHold) return;
      const hold = (e) => { if (e.target instanceof HTMLMediaElement) hush(e.target); };
      const release = (e) => {
        if (!e.isTrusted) return;
        document.removeEventListener("play", hold, true);
        document.removeEventListener("volumechange", hold, true);
        window.removeEventListener("pointerdown", release, true);
        window.removeEventListener("keydown", release, true);
        window.__playInMpvHold = false;
      };
      // Media events don't bubble, but a capturing listener on the document sees them.
      document.addEventListener("play", hold, true);
      document.addEventListener("volumechange", hold, true);
      window.addEventListener("pointerdown", release, true);
      window.addEventListener("keydown", release, true);
      window.__playInMpvHold = true;
    },
  }).catch(() => {});
}

// What to open in a pop-out for this feed: only the player frame that loaded it
// (src), with the page that embedded that frame as Referer (ref); and a fallback
// for players that refuse to run outside their site (page, sent with pageRef).
// The fallback is the frame the page itself embedded, holding the player: many
// sites load each stream into a frame without changing the page's address, so
// reloading the address would only bring back the site's front page. With no
// frame in between, it's the whole page.
async function popoutTarget(tab, stream) {
  const target = { src: tab.url, ref: "", page: tab.url, pageRef: "" };
  if (!stream.frameId) return target;
  // Look the frame up by the document that loaded the feed: the frame itself may
  // have moved on to another page since (then there's no match, so use the page).
  const f = await chrome.webNavigation.getFrame(
    stream.documentId ? { documentId: stream.documentId } : { tabId: tab.id, frameId: stream.frameId }
  ).catch(() => null);
  if (!f || !/^https?:/i.test(f.url)) return target;
  const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null)) || [];
  const byId = (id) => frames.find((x) => x.frameId === id);
  const parent = byId(f.parentFrameId);
  target.src = f.url;
  target.ref = parent && /^https?:/i.test(parent.url) ? parent.url : tab.url;
  let outer = { ...f, frameId: stream.frameId };
  while (outer.parentFrameId > 0 && byId(outer.parentFrameId)) outer = byId(outer.parentFrameId);
  if (outer.parentFrameId === 0 && outer.frameId !== stream.frameId && /^https?:/i.test(outer.url)) {
    target.page = outer.url;
    target.pageRef = tab.url;
  }
  return target;
}
