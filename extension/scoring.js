// Feed scoring shared by background.js and popup.js.
//
// Each feed's score decays over time, so it reflects what's playing *now*: after
// switching feeds on a page that doesn't reload, the old feed fades out within
// seconds instead of winning on its accumulated history.

const DECAY_MS = 10000;         // score falls to ~37% after 10s without activity
const PLAYLIST_WEIGHT = 1;      // successful playlist (re)load
const CHUNK_WEIGHT = 10;        // video chunk downloaded — only the live feed gets these
const LIVE_MS = 15000;          // active this recently = shown as "live"
const CHUNK_ATTRIBUTION_MS = 10000; // cross-server chunk credits a playlist loaded this recently

function currentScore(s, now) {
  if (s.dead) return -1;
  if (!s.score) return 0;
  return s.score * Math.exp(-(now - s.scoreAt) / DECAY_MS);
}

function addScore(s, weight, now) {
  s.score = currentScore(s, now) + weight;
  s.scoreAt = now;
  s.lastActive = now;
}

function pickBest(streams, now) {
  return streams.reduce((best, s) => (currentScore(s, now) > currentScore(best, now) ? s : best), streams[0]);
}

function isLive(s, now) {
  return !s.dead && s.lastActive != null && now - s.lastActive < LIVE_MS;
}

function dirOf(url) {
  const u = new URL(url);
  return u.origin + u.pathname.replace(/[^/]*$/, "");
}

// Which playlist does a downloaded chunk belong to?
// 1. A playlist in the same folder (or a parent folder) — most recently loaded first.
// 2. Otherwise, the playlist loaded most recently, if within CHUNK_ATTRIBUTION_MS:
//    players fetch the playlist and then its next chunk, often from a different
//    CDN server than the playlist itself.
function matchChunk(streams, chunkUrl, now) {
  const live = streams.filter((s) => !s.dead && s.lastLoad != null);
  const byRecentLoad = (a, b) => b.lastLoad - a.lastLoad;
  const dir = dirOf(chunkUrl);
  const sameDir = live.filter((s) => dir.startsWith(dirOf(s.url))).sort(byRecentLoad);
  if (sameDir.length) return sameDir[0];
  const recent = live.filter((s) => now - s.lastLoad < CHUNK_ATTRIBUTION_MS).sort(byRecentLoad);
  return recent[0] || null;
}

if (typeof module !== "undefined") {
  module.exports = { currentScore, addScore, pickBest, isLive, matchChunk, dirOf, DECAY_MS, PLAYLIST_WEIGHT, CHUNK_WEIGHT };
}
