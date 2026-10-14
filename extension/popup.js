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
  if (s.imageChunks) return `🖼 browser only — ${s.url}`;
  const state = isLive(s, now) ? "live" : s.lastActive ? `idle ${ago(now - s.lastActive)}` : "idle";
  return `${s === best ? "★ " : ""}${state} · ${s.segs} chunks, ${s.hits} loads — ${s.url}`;
}

async function play(tab, stream) {
  status("Launching mpv…");
  const referrer = stream.initiator ? stream.initiator + "/" : tab.url;
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST, {
      url: stream.url,
      referrer,
      origin: stream.initiator || "",
      userAgent: navigator.userAgent,
      title: tab.title || "Stream",
      autoReload: $("autoReload").checked,
    });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : "No response from helper");
  } catch (e) {
    status("Failed: " + e.message + "\nLog: ~/.cache/play-in-mpv.log", true);
    return;
  }
  if ($("pause").checked) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => document.querySelectorAll("video").forEach((v) => { v.pause(); v.muted = true; }),
    }).catch(() => {});
  }
  status("Playing in mpv ✔");
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
  const best = pickBest(streams, now);
  // Strongest feeds first, dead ones last.
  streams.sort((a, b) => currentScore(b, now) - currentScore(a, now));
  $("playBest").disabled = false;
  $("playBest").textContent = "▶ Play in mpv";
  $("playBest").onclick = () => play(tab, best);
  if (best.imageChunks) {
    status("This feed hides its video inside image files, which only the site's player can unpack — " +
      "mpv can't play it. Try another feed on the site, or watch it in the browser.", true);
  }

  for (const s of streams) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = describe(s, best, now);
    if (s.dead) span.style.opacity = "0.5";
    span.title = s.url;
    const btn = document.createElement("button");
    btn.textContent = "Play";
    btn.onclick = () => play(tab, s);
    li.append(span, btn);
    $("list").append(li);
  }
})();
