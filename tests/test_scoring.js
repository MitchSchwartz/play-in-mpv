// Tests for extension/scoring.js. Run from the repo root:  node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const { pruneGone, addScore, pickBest, isLive, matchChunk, currentScore, PLAYLIST_WEIGHT, CHUNK_WEIGHT } = require("../extension/scoring.js");

function feed(url) {
  return { url, hits: 0, segs: 0, dead: false, score: 0, scoreAt: 0, lastLoad: null, lastActive: null };
}

// One live-HLS cycle: reload the playlist, then download a chunk (attributed the
// same way background.js does it).
function cycle(streams, playlist, chunkUrl, now) {
  playlist.hits++;
  playlist.lastLoad = now;
  addScore(playlist, PLAYLIST_WEIGHT, now);
  const match = matchChunk(streams, chunkUrl, now + 300);
  if (match) {
    match.segs++;
    addScore(match, CHUNK_WEIGHT, now + 300);
  }
}

test("switching feeds: the new feed wins within ~10s despite the old one's history", () => {
  const a = feed("https://cdn-a.example/live/a/index.m3u8");
  const b = feed("https://cdn-b.example/live/b/index.m3u8");
  const streams = [a, b];
  let t = 0;
  for (; t < 10 * 60 * 1000; t += 4000) cycle(streams, a, "https://cdn-a.example/live/a/seg.ts", t);
  assert.strictEqual(pickBest(streams, t), a);
  assert.ok(a.segs > 100);

  const switchedAt = t;
  let wonAt = null;
  for (; t < switchedAt + 60000; t += 4000) {
    cycle(streams, b, "https://cdn-b.example/live/b/seg.ts", t);
    if (wonAt === null && pickBest(streams, t + 1000) === b) wonAt = t;
  }
  assert.ok(wonAt !== null, "new feed never took over");
  assert.ok(wonAt - switchedAt <= 12000, `took ${wonAt - switchedAt}ms to switch`);
  assert.ok(isLive(b, t) && !isLive(a, t));
});

test("chunks from a different CDN host credit the playlist loaded just before", () => {
  const decoy = feed("https://decoy.example/hls/x.m3u8");
  const real = feed("https://origin.example/hls/real.m3u8");
  const streams = [decoy, real];
  decoy.lastLoad = 0;
  real.lastLoad = 5000;
  assert.strictEqual(matchChunk(streams, "https://edge-cdn.example/v/123.png", 5500), real);
});

test("cross-host chunks are not credited to a playlist that stopped loading", () => {
  const old = feed("https://origin.example/hls/old.m3u8");
  old.lastLoad = 0;
  assert.strictEqual(matchChunk([old], "https://edge-cdn.example/v/1.ts", 60000), null);
});

test("same-folder playlist beats a more recent playlist elsewhere", () => {
  const a = feed("https://cdn.example/live/a/index.m3u8");
  const b = feed("https://other.example/live/b/index.m3u8");
  a.lastLoad = 0;
  b.lastLoad = 5000;
  assert.strictEqual(matchChunk([a, b], "https://cdn.example/live/a/seg42.ts", 5500), a);
});

test("dead feeds never win and never get chunks", () => {
  const dead = feed("https://cdn.example/live/index.m3u8");
  dead.dead = true;
  dead.lastLoad = 1000;
  const ok = feed("https://other.example/x.m3u8");
  addScore(ok, PLAYLIST_WEIGHT, 1000);
  assert.strictEqual(currentScore(dead, 2000), -1);
  assert.strictEqual(pickBest([dead, ok], 2000), ok);
  assert.strictEqual(matchChunk([dead], "https://cdn.example/live/seg.ts", 1500), null);
});

test("streams saved by the previous version (no score fields) still work", () => {
  const legacy = { url: "https://x.example/a.m3u8", hits: 50, segs: 200, dead: false };
  const fresh = feed("https://y.example/b.m3u8");
  addScore(fresh, PLAYLIST_WEIGHT, 1000);
  assert.strictEqual(currentScore(legacy, 1000), 0);
  assert.strictEqual(pickBest([legacy, fresh], 1000), fresh);
});

test("links from players no longer on the page are dropped", () => {
  const old = { ...feed("https://a.example/old.m3u8"), documentId: "DOC-OLD" };
  const cur = { ...feed("https://b.example/new.m3u8"), documentId: "DOC-NEW" };
  const unknown = feed("https://c.example/x.m3u8");
  const kept = pruneGone([old, cur, unknown], new Set(["DOC-MAIN", "DOC-NEW"]));
  assert.deepStrictEqual(kept.map((s) => s.url), [cur.url, unknown.url]);
});

test("chunks only credit playlists from the same player document", () => {
  const other = { ...feed("https://cdn.example/live/a/index.m3u8"), documentId: "DOC-1", lastLoad: 5000 };
  const mine = { ...feed("https://elsewhere.example/b/index.m3u8"), documentId: "DOC-2", lastLoad: 1000 };
  // Same folder as `other`, but requested by DOC-2's player.
  assert.strictEqual(matchChunk([other, mine], "https://cdn.example/live/a/seg.ts", 5500, "DOC-2"), mine);
  // Without a document id, falls back to folder matching.
  assert.strictEqual(matchChunk([other, mine], "https://cdn.example/live/a/seg.ts", 5500), other);
});
