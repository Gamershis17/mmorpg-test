// Slice 2 smoke test — two (plus a guest) WebSocket clients against a real
// server on a test port with the JSON fallback store.
//   npm test
// Spawns its own server, runs the checks, kills it, and verifies persistence
// across a server restart. Exits non-zero on the first failure.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = "/tmp/mmorpg-test-smoke-data";

let failures = 0;
function ok(label, cond, extra) {
  if (cond) console.log("  PASS " + label + (extra ? " — " + extra : ""));
  else { failures++; console.log("  FAIL " + label + (extra ? " — " + extra : "")); throw new Error("FAIL: " + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error("timeout waiting for: " + label);
}
async function api(path, { method = "GET", token = null, body = null } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

let server = null;
async function startServer() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  server = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, GM_ACCOUNTS: "cody" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.stdout.write("[server] " + d));
  server.stderr.on("data", (d) => process.stdout.write("[server:err] " + d));
  await waitFor(async () => {
    try { const h = await api("/api/health"); return h.ok === true; } catch { return false; }
  }, 10000, "server health");
  console.log("  PASS server started on port " + PORT);
}
async function stopServer() {
  if (!server) return;
  server.kill("SIGTERM");
  await new Promise((r) => server.on("exit", r));
  server = null;
  await sleep(300);
}

// --- WS client wrapper -------------------------------------------------
function makeClient(label) {
  const c = { label, ws: null, snaps: [], chats: [], chars: [], kills: [], shopResults: [], gmResults: [], inspects: [], welcome: null, lastSnap: null, dead: false, respawned: null };
  c.connect = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    c.ws = ws;
    ws.on("open", () => resolve());
    ws.on("error", reject);
    ws.on("message", (raw) => {
      let m = null; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === "welcome") c.welcome = m;
      else if (m.t === "snap") { c.snaps.push(m); c.lastSnap = m; }
      else if (m.t === "chat") c.chats.push(m);
      else if (m.t === "char") c.chars.push(m.char);
      else if (m.t === "kill") c.kills.push(m);
      else if (m.t === "shopResult") c.shopResults.push(m);
      else if (m.t === "gmResult") c.gmResults.push(m);
      else if (m.t === "inspect") c.inspects.push(m);
      else if (m.t === "dead") c.dead = true;
      else if (m.t === "respawned") c.respawned = m;
    });
  });
  c.send = (o) => c.ws.send(JSON.stringify(o));
  c.join = (token, char) => c.send({ t: "join", token, char });
  c.close = () => { try { c.ws.close(); } catch {} };
  c.pos = (x, y) => c.send({ t: "pos", x: Math.round(x), y: Math.round(y), face: 1, moving: true });
  return c;
}
async function walkTo(c, tx, ty) {
  // move in <=300px steps (server clamps teleports at 400px); start from the
  // position the server last reported for us, so steps are always accepted
  let self = (c.lastSnap && c.lastSnap.players || []).find((pl) => c.welcome && pl.id === c.welcome.you.id);
  let x = self ? self.x : 640, y = self ? self.y : 900;
  for (let i = 0; i < 40; i++) {
    const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy);
    if (d < 40) break;
    const step = Math.min(300, d);
    x += (dx / d) * step; y += (dy / d) * step;
    c.pos(x, y);
    await sleep(120);
  }
  return { x, y };
}

// --- main --------------------------------------------------------------
async function main() {
  console.log("slice 2 smoke test");
  await startServer();

  // 1. accounts: cody is GM by default, bob is not
  const cody = await api("/api/register", { method: "POST", body: { name: "cody", password: "pw123" } });
  ok("register cody", cody.ok === true && cody.account.isGM === true, "GM=" + cody.account.isGM);
  const bob = await api("/api/register", { method: "POST", body: { name: "bob", password: "pw123" } });
  ok("register bob", bob.ok === true && bob.account.isGM === false);
  const guest = await api("/api/guest", { method: "POST", body: {} });
  ok("guest account", guest.ok === true && guest.account.guest === true, guest.account.name);

  // 2. characters + save/load round-trip via the API (JSON store)
  const cc = await api("/api/characters", { method: "POST", token: cody.token, body: { name: "CodyTest", cls: "hunter" } });
  ok("cody creates CodyTest (hunter)", cc.ok === true && cc.character.name === "CodyTest");
  const bc = await api("/api/characters", { method: "POST", token: bob.token, body: { name: "BobTest", cls: "warrior" } });
  ok("bob creates BobTest (warrior)", bc.ok === true);
  const gc = await api("/api/characters", { method: "POST", token: guest.token, body: { name: "GuestTest", cls: "mage" } });
  ok("guest creates GuestTest (mage)", gc.ok === true);
  const list = await api("/api/characters", { token: cody.token });
  ok("character list round-trip", list.ok && list.characters.some((ch) => ch.name === "CodyTest"), list.characters.map((ch) => ch.name).join(","));

  // 3. three clients join the world
  const A = makeClient("cody"), B = makeClient("bob"), C = makeClient("guest");
  await A.connect(); await B.connect(); await C.connect();
  A.join(cody.token, "CodyTest"); B.join(bob.token, "BobTest"); C.join(guest.token, "GuestTest");
  await waitFor(() => A.welcome && B.welcome && C.welcome, 5000, "all three welcomes");
  ok("all three joined (welcome)", true, "A id=" + A.welcome.you.id + " B id=" + B.welcome.you.id);
  await waitFor(() => A.lastSnap && B.lastSnap && C.lastSnap, 5000, "first snapshots");
  ok("snapshots flowing", true);

  // 4. each client sees the others (positions synced)
  await walkTo(A, 1000, 900);
  const seenA = await waitFor(() => {
    const p = (B.lastSnap.players || []).find((pl) => pl.name === "CodyTest");
    return p && Math.abs(p.x - 1000) < 80 && Math.abs(p.y - 900) < 80 ? p : null;
  }, 5000, "B sees A at (1000,900)");
  ok("B sees A moved", true, "CodyTest at " + Math.round(seenA.x) + "," + Math.round(seenA.y));
  const seenB = await waitFor(() => {
    const p = (A.lastSnap.players || []).find((pl) => pl.name === "BobTest");
    return p || null;
  }, 5000, "A sees B");
  ok("A sees B", true, "BobTest at " + Math.round(seenB.x) + "," + Math.round(seenB.y));
  const seenG = await waitFor(() => {
    const p = (A.lastSnap.players || []).find((pl) => pl.name === "GuestTest");
    return p || null;
  }, 5000, "A sees guest");
  ok("A sees guest", true);
  // same enemies for everyone (server-owned)
  const idsA = (A.lastSnap.enemies || []).map((e) => e.id).sort().join(",");
  const idsB = (B.lastSnap.enemies || []).map((e) => e.id).sort().join(",");
  ok("both clients see the same enemies", idsA === idsB && idsA.length > 0, (A.lastSnap.enemies || []).length + " enemies");

  // 5. world chat
  A.send({ t: "chat", text: "hello vale" });
  const chat = await waitFor(() => B.chats.find((m) => m.from === "CodyTest" && m.text === "hello vale"), 5000, "chat round-trip");
  ok("chat goes through", !!chat, chat.from + ": " + chat.text);

  // 6. combat: A walks to the nearest enemy and attacks until it dies
  const target = (() => {
    let best = null, bd = 1e9;
    for (const e of A.lastSnap.enemies || []) {
      const d = Math.hypot(e.x - 1000, e.y - 900);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  })();
  ok("enemy target found", !!target, target.kind + " id=" + target.id);
  await walkTo(A, target.x, target.y);
  const killsBefore = A.kills.length;
  const t0 = Date.now();
  let killed = null, attempts = 0;
  while (Date.now() - t0 < 45000) {
    const cur = (A.lastSnap.enemies || []).find((e) => e.id === target.id);
    if (!cur) break; // already dead / despawned
    if (attempts > 0 && attempts % 5 === 0) await walkTo(A, cur.x, cur.y); // re-close if it wandered off
    A.send({ t: "atk", id: target.id, from: "player" });
    attempts++;
    await sleep(650);
    killed = A.kills.find((k) => k.id === target.id);
    if (killed) break;
  }
  ok("kill flow (attack until dead)", !!killed, killed ? "+" + killed.gold + "g +" + killed.xp + "xp" : "no kill in 45s");
  const afterKill = await waitFor(() => A.chars.find((ch) => ch.kills >= 1 && ch.gold > 60), 5000, "char update after kill");
  ok("kill rewards land (gold/xp)", !!afterKill, "gold=" + afterKill.gold + " xp=" + afterKill.xp);

  // 7. shop: buy a potion with gold
  const goldBefore = afterKill.gold;
  A.send({ t: "shop", shop: "shop", action: "buy", id: "potion", qty: 1 });
  const shopOk = await waitFor(() => A.shopResults.find((r) => r.ok === true), 5000, "shop buy result");
  ok("shop buy succeeds", !!shopOk, shopOk.message);
  const afterBuy = await waitFor(() => A.chars.find((ch) => ch.gold === goldBefore - 25 && (ch.items || []).some((it) => it.id === "potion")), 5000, "char after buy");
  ok("potion in inventory, gold -25", !!afterBuy, "gold=" + afterBuy.gold);

  // 8. GM: cody gives bob 500 gold, inspects him, sets own level past 60
  B.chars.length = 0;
  A.send({ t: "gm", action: "giveGold", target: "BobTest", amount: 500 });
  const bobRich = await waitFor(() => B.chars.find((ch) => ch.gold === 560), 5000, "bob receives 500 gold");
  ok("GM give gold to another player", !!bobRich, "BobTest gold=" + bobRich.gold);
  A.send({ t: "gm", action: "inspect", target: "BobTest" });
  const insp = await waitFor(() => A.inspects.find((m) => m.name === "BobTest"), 5000, "GM inspect");
  ok("GM inspect other player", !!insp, "Lv " + insp.level + " gold=" + insp.gold + " hp=" + insp.hp + "/" + insp.maxHp);
  A.send({ t: "gm", action: "setLevel", target: "self", level: 75 });
  const lv75 = await waitFor(() => A.chars.find((ch) => ch.level === 75), 5000, "GM level 75");
  ok("GM set level past the 60 cap", !!lv75, "level=" + lv75.level);

  // 9. non-GM GM attempt is rejected
  B.send({ t: "gm", action: "giveGold", target: "CodyTest", amount: 9999 });
  const denied = await waitFor(() => B.gmResults.find((r) => r.ok === false), 5000, "non-GM rejection");
  ok("non-GM GM action rejected", !!denied, denied.error);
  const codyList = await api("/api/characters", { token: cody.token });
  const codyChar = codyList.characters.find((ch) => ch.name === "CodyTest");
  ok("rejected give did not land", codyChar.gold < 9000, "CodyTest gold=" + codyChar.gold);

  // 10. disconnect → JSON file on disk has the saved character
  A.close(); B.close(); C.close();
  await sleep(1000);
  const file = join(DATA_DIR, "accounts.json");
  ok("JSON store file written", existsSync(file), file);
  const saved = JSON.parse(readFileSync(file, "utf-8"));
  const savedCody = (saved.accounts || []).find((a) => a.name === "cody");
  const savedChar = savedCody && savedCody.characters.find((ch) => ch.name === "CodyTest");
  ok("saved character on disk (level 75)", !!savedChar && savedChar.level === 75, savedChar ? "level=" + savedChar.level : "missing");

  // 11. restart the server → characters load back from the file
  await stopServer();
  server = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, GM_ACCOUNTS: "cody" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitFor(async () => {
    try { const h = await api("/api/health"); return h.ok === true; } catch { return false; }
  }, 10000, "server restart health");
  const login2 = await api("/api/login", { method: "POST", body: { name: "cody", password: "pw123" } });
  ok("login after restart", login2.ok === true);
  const list2 = await api("/api/characters", { token: login2.token });
  const reloaded = list2.characters.find((ch) => ch.name === "CodyTest");
  ok("character survives server restart", !!reloaded && reloaded.level === 75 && reloaded.gold === codyChar.gold,
    reloaded ? "level=" + reloaded.level + " gold=" + reloaded.gold : "missing");

  await stopServer();
  console.log(failures === 0 ? "\nALL SMOKE TESTS PASSED" : "\n" + failures + " FAILURES");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("SMOKE TEST ERROR:", e.message);
  try { await stopServer(); } catch {}
  process.exit(1);
});
