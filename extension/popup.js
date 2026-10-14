const HOST = "local.play_in_mpv";
const $ = (id) => document.getElementById(id);

function status(msg, isErr = false) {
  $("status").textContent = msg;
  $("status").className = isErr ? "err" : "";
}

function ago(ms) {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`;
}

function describe(s, best, now) {
  if (s.dead) return `✖ dead — ${s.url}`;
  if (s.browserOnly) return `🖼 browser only — ${s.url}`;
  const state = isLive(s, now) ? "live" : s.lastActive ? `idle ${ago(now - s.lastActive)}` : "idle";
  return `${s === best ? "★ " : ""}${state} · ${s.segs} chunks, ${s.hits} loads — ${s.url}`;
}

// Auto-reload toggle: saved in the extension and pushed to the helper, which
// writes the settings file that open mpv windows poll.
async function setupAutoReload() {
  const { autoReload = true } = await chrome.storage.local.get("autoReload");
  $("autoReload").checked = autoReload;
  $("autoReload").onchange = async () => {
    const enabled = $("autoReload").checked;
    await chrome.storage.local.set({ autoReload: enabled });
    try {
      const res = await chrome.runtime.sendNativeMessage(HOST, { action: "settings", autoReload: enabled });
      if (!res || !res.ok) throw new Error(res && res.error ? res.error : "No response from helper");
      status(`Auto-reload ${enabled ? "on" : "off"} — applied to open mpv windows`);
    } catch (e) {
      status("Saved, but couldn't reach the helper: " + e.message, true);
    }
  };
}

// Ask the helper to play one feed. It checks the feed's first chunk and refuses
// (browserOnly) if the video is hidden in images, without opening mpv.
async function launch(tab, stream) {
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST, {
      url: stream.url,
      referrer: stream.initiator ? stream.initiator + "/" : tab.url,
      origin: stream.initiator || "",
      userAgent: navigator.userAgent,
      title: tab.title || "Stream",
      autoReload: $("autoReload").checked,
      // Exact headers the browser sent for this playlist (cookies, tokens, referer).
      headers: stream.headers || null,
    });
    return res || { ok: false, error: "No response from helper" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function markBrowserOnly(tab, stream) {
  stream.browserOnly = true;
  chrome.runtime.sendMessage({ type: "browserOnly", tabId: tab.id, url: stream.url }).catch(() => {});
}

function pauseBrowserVideo(tab) {
  if (!$("pause").checked) return Promise.resolve();
  return chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => document.querySelectorAll("video").forEach((v) => { v.pause(); v.muted = true; }),
  }).catch(() => {});
}

// Open only the player frame that loaded this feed as its own popup window (a normal
// page, so Brave Shields apply). background.js opens and guards the window, passing
// the page that embedded the player as Referer.
async function popOut(tab, stream) {
  let src = tab.url;
  let ref = "";
  if (stream.frameId) {
    const f = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: stream.frameId }).catch(() => null);
    if (f && /^https?:/i.test(f.url)) {
      src = f.url;
      const parent = f.parentFrameId >= 0
        ? await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: f.parentFrameId }).catch(() => null)
        : null;
      ref = parent && /^https?:/i.test(parent.url) ? parent.url : tab.url;
    }
  }
  await pauseBrowserVideo(tab);
  await chrome.runtime.sendMessage({ type: "popOut", src, ref });
  window.close();
}

// Try feeds best-first; skip any the helper reports as image-disguised.
async function playFeeds(tab, candidates, render) {
  $("playBest").disabled = true;
  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];
    status(candidates.length > 1 ? `Checking feed ${i + 1} of ${candidates.length}…` : "Launching mpv…");
    const res = await launch(tab, s);
    if (res.ok) {
      pauseBrowserVideo(tab);
      status("Playing in mpv ✔");
      render(s);
      $("playBest").disabled = false;
      return;
    }
    if (!res.browserOnly) {
      status("Failed: " + res.error + "\nLog: ~/.cache/play-in-mpv.log", true);
      $("playBest").disabled = false;
      return;
    }
    markBrowserOnly(tab, s);
    render();
  }
  status("Every feed on this page hides its video in images, which mpv can't play. " +
    "Use ⧉ Pop out player to watch just the player in a light window.", true);
}

(async () => {
  await setupAutoReload();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const key = `tab_${tab.id}`;
  let streams = (await chrome.storage.session.get(key))[key] || [];

  // Hide links from players that are no longer on the page (and forget them).
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null);
  if (frames) {
    const kept = pruneGone(streams, new Set(frames.map((f) => f.documentId).filter(Boolean)));
    if (kept.length !== streams.length) {
      streams = kept;
      await chrome.storage.session.set({ [key]: streams });
    }
  }
  if (!streams.length) return;

  const now = Date.now();
  // Strongest feeds first.
  streams.sort((a, b) => currentScore(b, now) - currentScore(a, now));

  function render(playing) {
    const best = playing || pickBest(streams, now);
    $("list").replaceChildren();
    for (const s of streams) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = describe(s, best, now);
      if (s.dead || s.browserOnly) span.style.opacity = "0.5";
      span.title = s.url;
      const btn = document.createElement("button");
      btn.textContent = "Play";
      btn.onclick = () => playFeeds(tab, [s], render);
      li.append(span, btn);
      $("list").append(li);
    }
  }
  render();

  // Pop out the strongest live feed's player, even if mpv can't play it.
  const popTarget = streams.find((s) => !s.dead);
  if (popTarget) {
    $("popOut").disabled = false;
    $("popOut").onclick = () => popOut(tab, popTarget);
  }

  if (!rankFeeds(streams, now).length) {
    status("No feed mpv can play here (dead, or video hidden in images). " +
      "Use ⧉ Pop out player to watch just the player in a light window.", true);
    return;
  }
  $("playBest").disabled = false;
  $("playBest").textContent = "▶ Play in mpv";
  $("playBest").onclick = () => playFeeds(tab, rankFeeds(streams, now), render);
})();
