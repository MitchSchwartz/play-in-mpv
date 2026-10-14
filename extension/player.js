// Pop-out player: shows only the site's player frame in its own window.
//
// Query params: src (the player frame's URL), ref (the page that embedded it),
// title. Embeds often refuse to play outside their site, so for this tab only we
// send the original page as the Referer and drop the headers that forbid framing.
// The rule is removed when the tab closes (background.js).

const params = new URLSearchParams(location.search);
const src = params.get("src");
const ref = params.get("ref");
const title = params.get("title") || "Player";
const frame = document.getElementById("player");

document.title = title;
document.getElementById("title").textContent = title;

function load() {
  // Re-assigning src restarts the player from scratch, which also brings back
  // hardware decoding if the browser fell back to the CPU after a glitch.
  frame.src = "about:blank";
  setTimeout(() => { frame.src = src; }, 50);
}

async function start() {
  if (!src || !/^https?:/i.test(src)) {
    document.getElementById("title").textContent = "No player URL";
    return;
  }
  const tab = await chrome.tabs.getCurrent();
  const responseHeaders = [
    { header: "x-frame-options", operation: "remove" },
    { header: "content-security-policy", operation: "remove" },
  ];
  const action = { type: "modifyHeaders", responseHeaders };
  if (ref && /^https?:/i.test(ref)) {
    action.requestHeaders = [{ header: "referer", operation: "set", value: ref }];
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tab.id],
    addRules: [{
      id: tab.id,
      priority: 1,
      action,
      condition: {
        tabIds: [tab.id],
        resourceTypes: ["sub_frame"],
        requestDomains: [new URL(src).hostname],
      },
    }],
  });
  load();
}

document.getElementById("reload").onclick = load;
document.getElementById("hide").onclick = () => document.body.classList.add("hide-bar");
document.addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") load();
  if (e.key === "b" || e.key === "B") document.body.classList.toggle("hide-bar");
});

start();
