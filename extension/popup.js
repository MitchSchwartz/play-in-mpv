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

async function launch(tab, stream) {
  const player = $("player").value;
  const res = await launchFeed(tab, stream, { player, autoReload: $("autoReload").checked });
  if (res.session) {
    chrome.runtime.sendMessage({ type: "followFeed", tabId: tab.id, url: stream.url, session: res.session }).catch(() => {});
  }
  return res;
}

function markBrowserOnly(tab, stream) {
  stream.browserOnly = true;
  chrome.runtime.sendMessage({ type: "browserOnly", tabId: tab.id, url: stream.url }).catch(() => {});
}

function pauseBrowserVideo(tab) {
  return $("pause").checked ? pauseVideos(tab.id) : Promise.resolve();
}

// Open only the player frame that loaded this feed as its own popup window (a normal
// page, so Brave Shields apply). background.js opens and guards the window.
async function popOut(tab, stream) {
  const target = await popoutTarget(tab, stream);
  await pauseBrowserVideo(tab);
  await chrome.runtime.sendMessage({
    type: "popOut", ...target,
    autoplay: $("autoplay").checked,
    fullscreen: $("fullscreen").checked,
  });
  window.close();
}

// Try feeds best-first; skip any the helper reports as image-disguised.
async function playFeeds(tab, candidates, render) {
  $("playBest").disabled = true;
  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];
    status(candidates.length > 1 ? `Checking feed ${i + 1} of ${candidates.length}…` : `Launching ${playerName()}…`);
    const res = await launch(tab, s);
    if (res.ok) {
      pauseBrowserVideo(tab);
      status(res.warning ? `Opened in ${playerName()}. ${res.warning}` : `Playing in ${playerName()} ✔`, !!res.warning);
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
  status(`Every feed on this page hides its video in images, which ${playerName()} can't play. ` +
    "Use ⧉ Watch in pop-out to watch just the player in a light window.", true);
}

// External player choice (mpv or VLC), remembered between uses.
const playerName = () => ($("player").value === "vlc" ? "VLC" : "mpv");
async function setupPlayerChoice() {
  const { player = "mpv" } = await chrome.storage.local.get("player");
  $("player").value = player;
  const label = () => { $("playBest").textContent = `▶ Play in ${playerName()}`; };
  label();
  $("player").onchange = () => {
    chrome.storage.local.set({ player: $("player").value });
    label();
  };
}

// Pop-out options, remembered between uses.
async function setupPopoutOptions() {
  const { popoutAutoplay = true, popoutFullscreen = true } =
    await chrome.storage.local.get(["popoutAutoplay", "popoutFullscreen"]);
  $("autoplay").checked = popoutAutoplay;
  $("fullscreen").checked = popoutFullscreen;
  $("autoplay").onchange = () => chrome.storage.local.set({ popoutAutoplay: $("autoplay").checked });
  $("fullscreen").onchange = () => chrome.storage.local.set({ popoutFullscreen: $("fullscreen").checked });
  const { pauseOriginal = true } = await chrome.storage.local.get("pauseOriginal");
  $("pause").checked = pauseOriginal;
  $("pause").onchange = () => chrome.storage.local.set({ pauseOriginal: $("pause").checked });
}

// Per-site automatic action: what to do on this site as soon as a video starts,
// without opening the popup (background.js does it).
async function setupSiteAction(tab) {
  const site = siteKey(tab.url);
  if (!site || !/^https?:/i.test(tab.url)) return;
  const { siteActions = {} } = await chrome.storage.local.get("siteActions");
  $("siteName").textContent = site;
  $("siteAction").value = siteActions[site] || "";
  $("siteRow").hidden = false;
  $("siteAction").onchange = async () => {
    const { siteActions = {} } = await chrome.storage.local.get("siteActions");
    if ($("siteAction").value) siteActions[site] = $("siteAction").value;
    else delete siteActions[site];
    await chrome.storage.local.set({ siteActions });
    status($("siteAction").value
      ? `Saved: videos on ${site} will open automatically from now on (reload the page to start this one).`
      : `Saved: nothing happens automatically on ${site}.`);
  };
}

// Diagnosing a stream the extension can't find: record this tab's requests, start
// the video, then copy them.
async function setupNetworkSummary(tab) {
  const { tabId } = (await chrome.runtime.sendMessage({ type: "recordingTab" }).catch(() => null)) || {};
  if (tabId === tab.id) {
    $("diagnose").textContent = "Copy network summary";
    $("diagnose").onclick = async () => {
      const res = await chrome.runtime.sendMessage({ type: "networkSummary", tabId: tab.id }).catch(() => null);
      if (!res) return status("Couldn't read the network summary", true);
      await navigator.clipboard.writeText(`${tab.url}\n${res.text}`);
      status(`Network summary copied (${res.count} requests).`);
    };
    return;
  }
  $("diagnose").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "recordNetwork", tabId: tab.id }).catch(() => null);
    status("Recording this tab's requests for 5 minutes. Start the video, let it play ~10 seconds, " +
      "then open this popup again and click Copy network summary.");
    $("diagnose").hidden = true;
  };
}

(async () => {
  await setupAutoReload();
  await setupPopoutOptions();
  await setupPlayerChoice();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await setupSiteAction(tab);
  setupNetworkSummary(tab);
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
    $("popOut").textContent = "⧉ Watch in pop-out";
    $("popOut").onclick = () => popOut(tab, popTarget);
  }

  if (!rankFeeds(streams, now).length) {
    status(`No feed ${playerName()} can play here (dead, or video hidden in images). ` +
      "Use ⧉ Watch in pop-out to watch just the player in a light window.", true);
    return;
  }
  $("playBest").disabled = false;
  $("playBest").onclick = () => playFeeds(tab, rankFeeds(streams, now), render);
})();
