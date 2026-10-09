const HOST = "local.play_in_mpv";
const $ = (id) => document.getElementById(id);

function status(msg, isErr = false) {
  $("status").textContent = msg;
  $("status").className = isErr ? "err" : "";
}

// Video chunks being downloaded is the strongest sign a feed is really playing;
// successful playlist reloads are next. Dead links never win.
function score(s) {
  return s.dead ? -1 : s.segs * 10 + s.hits;
}
function pickBest(streams) {
  return streams.reduce((best, s) => (score(s) > score(best) ? s : best), streams[0]);
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

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const key = `tab_${tab.id}`;
  const streams = (await chrome.storage.session.get(key))[key] || [];
  if (!streams.length) return;

  const best = pickBest(streams);
  $("playBest").disabled = false;
  $("playBest").textContent = "▶ Play in mpv";
  $("playBest").onclick = () => play(tab, best);

  for (const s of streams) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = s.dead ? `✖ dead — ${s.url}` : `${s === best ? "★ " : ""}${s.segs} chunks, ${s.hits} loads — ${s.url}`;
    if (s.dead) span.style.opacity = "0.5";
    span.title = s.url;
    const btn = document.createElement("button");
    btn.textContent = "Play";
    btn.onclick = () => play(tab, s);
    li.append(span, btn);
    $("list").append(li);
  }
})();
