"use strict";
/* =====================================================================
   MMORPG TEST — Slice 2: multiplayer server. Slice 3: the City, the Old
   Road, the river, Hunter pet taming, fishing, and city quests.
   Express serves public/ (the game), WebSocket runs the shared world:
   player sync, server-owned enemies, world chat, server accounts +
   characters, shops, and the GM console (server-validated).
   Postgres via pg Pool when DATABASE_URL is set; JSON-file fallback
   (the Galaxy Clicker pattern) so it runs locally without Neon.
   No credentials live in this file — env vars only.
   ===================================================================== */
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const GM_ACCOUNTS = (process.env.GM_ACCOUNTS || "cody")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const DATABASE_URL = process.env.DATABASE_URL || "";

function isGMName(name) {
  // Exact match only: the list is split on commas, trimmed, and lowercased
  // at startup, so "cody" never matches "codyfan" and "Gamershis17" matches
  // regardless of how the account name was cased at registration.
  return !!name && GM_ACCOUNTS.indexOf(String(name).trim().toLowerCase()) >= 0;
}

/* ---------------- shared game data (mirrors the client) ---------------- */
const CLASSES = {
  warrior: { label: "Warrior", hp: 150, dmg: 13, range: 52, atkRate: 0.85, speed: 178, resMax: 100 },
  mage: { label: "Mage", hp: 95, dmg: 19, range: 185, atkRate: 1.15, speed: 168, resMax: 100 },
  hunter: { label: "Hunter", hp: 115, dmg: 12, range: 175, atkRate: 0.95, speed: 176, resMax: 100 },
};
const ENEMY_TYPES = [
  { kind: "wolf", name: "Vale Wolf", hp: 42, dmg: 5, speed: 100, xp: 14, goldMin: 5, goldMax: 9, aggro: 190 },
  { kind: "boar", name: "Wild Boar", hp: 62, dmg: 7, speed: 82, xp: 19, goldMin: 6, goldMax: 12, aggro: 165 },
  { kind: "slime", name: "Thorn Slime", hp: 30, dmg: 4, speed: 58, xp: 11, goldMin: 3, goldMax: 7, aggro: 150 },
];
const WORLD = { w: 4200, h: 1800 };
const VILLAGE = { x: 640, y: 900, r: 355 };
// Slice 3 — the City (placeholder name until Cody names it) at the east end
// of the world, reached by the Old Road. The river runs along the city's
// east edge; its west bank is where players fish.
const CITY = { x: 3550, y: 900, r: 430 };
const CITY_GATE = { x: 3080, y: 900 };
const RIVER = { x0: 3980, x1: 4200, y0: 150, y1: 1650 };
const FISH_SPOTS = [{ x: 3945, y: 500 }, { x: 3945, y: 900 }, { x: 3945, y: 1300 }];
const TAMABLE_TYPES = [
  { kind: "otter", name: "River Otter", icon: "🦦", hp: 30, speed: 90, region: "river" },
  { kind: "fox", name: "City Fox", icon: "🦊", hp: 36, speed: 110, region: "outskirts" },
  { kind: "hawk", name: "Road Hawk", icon: "🦅", hp: 26, speed: 130, region: "road" },
];
const TAMABLE_TARGET = 6;
const FISH = {
  trout: { name: "River Trout", icon: "🐟", price: 8, desc: "A fresh river trout." },
  silverfin: { name: "Silverfin", icon: "🐠", price: 20, desc: "A shimmering silverfin." },
  carp: { name: "Golden Carp", icon: "🐡", price: 50, desc: "A rare golden carp!" },
  boot: { name: "Old Boot", icon: "🥾", price: 1, desc: "An old boot. The river gives and the river takes." },
};
function inRiver(x, y) { return x >= RIVER.x0 && x <= RIVER.x1 && y >= RIVER.y0 && y <= RIVER.y1; }
function zoneOf(x, y) { if (x > 3000) return "city"; if (x > 2650) return "road"; return "vale"; }
const QUEST_NEED = 5;
const LEVEL_CAP = 60;
const GEAR = {
  op_blade: { name: "Martin Fury, GM Blade", icon: "🗡️", slot: "weapon", dmg: 250, desc: "+250 Damage" },
  op_staff: { name: "Staff of Infinite Stars", icon: "🔮", slot: "weapon", dmg: 250, desc: "+250 Damage" },
  op_bow: { name: "Bow of the Vale God", icon: "🏹", slot: "weapon", dmg: 250, desc: "+250 Damage" },
  op_helm: { name: "Crown of Dawnhollow", icon: "👑", slot: "helm", hp: 500, desc: "+500 Health" },
  op_chest: { name: "Dragonscale Chestplate", icon: "🛡️", slot: "chest", hp: 800, desc: "+800 Health" },
  op_boots: { name: "Boots of the Wind", icon: "🥾", slot: "boots", speed: 70, desc: "+70 Speed" },
  iron_sword: { name: "Iron Sword", icon: "🗡️", slot: "weapon", dmg: 8, price: 120, desc: "+8 Damage" },
  apprentice_staff: { name: "Apprentice Staff", icon: "🔮", slot: "weapon", dmg: 8, price: 120, desc: "+8 Damage" },
  hunting_bow: { name: "Hunting Bow", icon: "🏹", slot: "weapon", dmg: 8, price: 120, desc: "+8 Damage" },
  leather_helm: { name: "Leather Helm", icon: "🪖", slot: "helm", hp: 40, price: 80, desc: "+40 Health" },
  chainmail_vest: { name: "Chainmail Vest", icon: "🛡️", slot: "chest", hp: 120, price: 200, desc: "+120 Health" },
  swift_boots: { name: "Swift Boots", icon: "🥾", slot: "boots", speed: 15, price: 90, desc: "+15 Speed" },
  // ---- City Armory stock (sold by Smith Garrick in the City) ----
  steel_blade: { name: "Steel Blade", icon: "🗡️", slot: "weapon", dmg: 16, price: 300, desc: "+16 Damage" },
  steel_bow: { name: "Steel Bow", icon: "🏹", slot: "weapon", dmg: 16, price: 300, desc: "+16 Damage" },
  steel_staff: { name: "Steel Staff", icon: "🔮", slot: "weapon", dmg: 16, price: 300, desc: "+16 Damage" },
  knight_helm: { name: "Knight Helm", icon: "🪖", slot: "helm", hp: 100, price: 200, desc: "+100 Health" },
  knight_armor: { name: "Knight Armor", icon: "🛡️", slot: "chest", hp: 260, price: 450, desc: "+260 Health" },
  traveler_boots: { name: "Traveler Boots", icon: "🥾", slot: "boots", speed: 30, price: 220, desc: "+30 Speed" },
};
const ITEMS = {
  bandage: { name: "Bandage", icon: "🩹", healPct: 0.25, price: 10, desc: "Restores 25% health" },
  potion: { name: "Healing Potion", icon: "🧪", healPct: 0.5, price: 25, desc: "Restores 50% health" },
  gpotion: { name: "Greater Healing Potion", icon: "⚗️", healPct: 1.0, price: 60, desc: "Restores 100% health" },
  city_bread: { name: "City Bread", icon: "🍞", healPct: 0.35, price: 15, desc: "Fresh from Baker Nell's oven. Restores 35% health" },
};
// General shop = consumables only. Armory = weapons + armor only.
const SHOP_CATALOG = ["bandage", "potion", "gpotion"];
const ARMORY_CATALOG = ["iron_sword", "apprentice_staff", "hunting_bow", "leather_helm", "chainmail_vest", "swift_boots"];
// Slice 3 — city shops. The market and the fishing vendor sell consumables;
// the city armory sells steel gear. All five shops share one handler.
const CITY_SHOP_CATALOG = ["bandage", "potion", "gpotion", "city_bread"];
const CITY_ARMORY_CATALOG = ["steel_blade", "steel_bow", "steel_staff", "knight_helm", "knight_armor", "traveler_boots"];
const FISH_CATALOG = ["bandage", "potion", "city_bread"];
const SHOPS = {
  shop: { catalog: SHOP_CATALOG, gear: false },
  armory: { catalog: ARMORY_CATALOG, gear: true },
  cityshop: { catalog: CITY_SHOP_CATALOG, gear: false },
  cityarmory: { catalog: CITY_ARMORY_CATALOG, gear: true },
  fishshop: { catalog: FISH_CATALOG, gear: false },
};
function sellPrice(id) {
  if (ITEMS[id]) return Math.max(1, Math.floor(ITEMS[id].price / 2));
  if (FISH[id]) return Math.max(1, Math.floor(FISH[id].price / 2));
  if (GEAR[id] && GEAR[id].price) return Math.max(1, Math.floor(GEAR[id].price / 2));
  return 250; // GM / OP gear flat resale
}

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function dist(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
function rand(a, b) { return a + Math.random() * (b - a); }
function randi(a, b) { return Math.floor(rand(a, b + 1)); }
function xpNeed(level) { return Math.round(80 * Math.pow(level, 1.32)); }
function inSafeZone(x, y) { return dist(x, y, VILLAGE.x, VILLAGE.y) < VILLAGE.r || dist(x, y, CITY.x, CITY.y) < CITY.r; }
function gearBonus(char) {
  const b = { hp: 0, dmg: 0, speed: 0 };
  if (char.gear) {
    for (const slot of Object.keys(char.gear)) {
      const id = char.gear[slot];
      if (id && GEAR[id]) { b.hp += GEAR[id].hp || 0; b.dmg += GEAR[id].dmg || 0; b.speed += GEAR[id].speed || 0; }
    }
  }
  return b;
}
function classStats(char) {
  const c = CLASSES[char.cls] || CLASSES.hunter;
  const gb = gearBonus(char);
  return {
    maxHp: c.hp + (char.level - 1) * 14 + gb.hp,
    dmg: c.dmg + (char.level - 1) * 2 + gb.dmg,
    range: c.range, atkRate: c.atkRate, speed: c.speed + gb.speed,
  };
}
function newCharacter(name, cls) {
  return {
    name, cls,
    level: 1, xp: 0, gold: 60, kills: 0,
    items: [], gear: { weapon: null, helm: null, chest: null, boots: null },
    quest: { state: "none", kills: 0 },
    extra: { pets: [], zone: "vale", quest2: { state: "none", count: 0 }, quest3: { state: "none" } },
  };
}
function sanitizeExtra(ex) {
  // Slice 3 data: tamed pets, current zone, city quests. Defensive defaults
  // so characters saved before slice 3 load cleanly.
  const e = (ex && typeof ex === "object") ? ex : {};
  const pets = Array.isArray(e.pets) ? e.pets.filter((pt) => pt && TAMABLE_TYPES.some((t) => t.kind === pt.type))
    .map((pt) => ({ type: pt.type, name: String(pt.name || "").slice(0, 24) || TAMABLE_TYPES.find((t) => t.kind === pt.type).name })) : [];
  return {
    pets,
    zone: ["vale", "road", "city"].indexOf(e.zone) >= 0 ? e.zone : "vale",
    quest2: {
      state: ["none", "active", "ready", "done"].indexOf(e.quest2 && e.quest2.state) >= 0 ? e.quest2.state : "none",
      count: clamp(Math.floor((e.quest2 && e.quest2.count) || 0), 0, 3),
    },
    quest3: { state: ["none", "active", "done"].indexOf(e.quest3 && e.quest3.state) >= 0 ? e.quest3.state : "none" },
  };
}
function sanitizeChar(ch) {
  // Defensive copy: never trust a stored character shape.
  const c = (ch && typeof ch === "object") ? ch : {};
  return {
    name: String(c.name || "Hero").slice(0, 16),
    cls: CLASSES[c.cls] ? c.cls : "hunter",
    level: clamp(Math.floor(c.level) || 1, 1, 999),
    xp: Math.max(0, Math.floor(c.xp) || 0),
    gold: Math.max(0, Math.floor(c.gold) || 0),
    kills: Math.max(0, Math.floor(c.kills) || 0),
    items: Array.isArray(c.items) ? c.items.filter((it) => it && typeof it.id === "string") : [],
    gear: {
      weapon: (c.gear && GEAR[c.gear.weapon]) ? c.gear.weapon : null,
      helm: (c.gear && GEAR[c.gear.helm]) ? c.gear.helm : null,
      chest: (c.gear && GEAR[c.gear.chest]) ? c.gear.chest : null,
      boots: (c.gear && GEAR[c.gear.boots]) ? c.gear.boots : null,
    },
    quest: {
      state: ["none", "active", "ready", "done"].indexOf(c.quest && c.quest.state) >= 0 ? c.quest.state : "none",
      kills: clamp(Math.floor((c.quest && c.quest.kills) || 0), 0, QUEST_NEED),
    },
    extra: sanitizeExtra(c.extra),
  };
}

/* ---------------- store: Postgres with JSON-file fallback ----------------
   Account shape: { name, passHash, salt, isGM, characters: [char] }
   Guest accounts are ephemeral (memory only) and never persisted. */
const store = {
  mode: "json",
  pool: null,
  jsonPath: path.join(DATA_DIR, "accounts.json"),
  jsonAccounts: [], // [{name, passHash, salt, isGM, characters}]
  jsonDirty: false,

  async init() {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* data dir may exist */ }
    if (DATABASE_URL) {
      try {
        const { Pool } = require("pg");
        this.pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
        await this.pool.query("SELECT 1");
        await this.pool.query(
          "CREATE TABLE IF NOT EXISTS accounts (" +
          "id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, " +
          "pass_hash TEXT NOT NULL, salt TEXT NOT NULL, " +
          "is_gm BOOLEAN NOT NULL DEFAULT FALSE, " +
          "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
        );
        await this.pool.query(
          "CREATE TABLE IF NOT EXISTS characters (" +
          "id SERIAL PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, " +
          "name TEXT NOT NULL, cls TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, " +
          "xp INTEGER NOT NULL DEFAULT 0, gold INTEGER NOT NULL DEFAULT 60, " +
          "kills INTEGER NOT NULL DEFAULT 0, items JSONB NOT NULL DEFAULT '[]', " +
          "gear JSONB NOT NULL DEFAULT '{\"weapon\":null,\"helm\":null,\"chest\":null,\"boots\":null}', " +
          "quest JSONB NOT NULL DEFAULT '{\"state\":\"none\",\"kills\":0}', " +
          "extra JSONB NOT NULL DEFAULT '{}', " +
          "UNIQUE(account_id, name))"
        );
        // The live table predates slice 3 — add the column if it is missing.
        await this.pool.query("ALTER TABLE characters ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'");
        this.mode = "postgres";
        console.log("[store] Postgres connected (Neon).");
        return;
      } catch (e) {
        console.log("[store] Postgres unavailable (" + (e && e.message ? e.message : e) + ") — falling back to JSON file.");
        try { if (this.pool) await this.pool.end().catch(() => {}); } catch (e2) { /* ignore */ }
        this.pool = null;
      }
    }
    this.mode = "json";
    this.loadJson();
    console.log("[store] JSON fallback active (" + this.jsonPath + ").");
  },

  loadJson() {
    try {
      const raw = fs.readFileSync(this.jsonPath, "utf8");
      const data = JSON.parse(raw);
      this.jsonAccounts = Array.isArray(data.accounts) ? data.accounts : [];
    } catch (e) {
      this.jsonAccounts = [];
    }
    // Defensive: sanitize every loaded account/character.
    this.jsonAccounts = this.jsonAccounts
      .filter((a) => a && typeof a.name === "string")
      .map((a) => ({
        name: a.name,
        passHash: typeof a.passHash === "string" ? a.passHash : "",
        salt: typeof a.salt === "string" ? a.salt : "",
        isGM: isGMName(a.name),
        characters: Array.isArray(a.characters) ? a.characters.map(sanitizeChar) : [],
      }));
  },

  saveJson() {
    if (!this.jsonDirty) return;
    this.jsonDirty = false;
    try {
      const tmp = this.jsonPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ accounts: this.jsonAccounts }, null, 2));
      fs.renameSync(tmp, this.jsonPath);
    } catch (e) {
      console.log("[store] JSON save failed: " + (e && e.message ? e.message : e));
      this.jsonDirty = true;
    }
  },

  async getAccount(name) {
    const key = String(name || "").toLowerCase();
    if (!key) return null;
    if (this.mode === "postgres") {
      const r = await this.pool.query("SELECT * FROM accounts WHERE lower(name) = $1", [key]);
      if (!r.rows.length) return null;
      const row = r.rows[0];
      const ch = await this.pool.query(
        "SELECT name, cls, level, xp, gold, kills, items, gear, quest, extra FROM characters WHERE account_id = $1 ORDER BY id",
        [row.id]
      );
      return {
        id: row.id, name: row.name, passHash: row.pass_hash, salt: row.salt,
        isGM: isGMName(row.name) || !!row.is_gm,
        characters: ch.rows.map((c) => sanitizeChar({
          name: c.name, cls: c.cls, level: c.level, xp: c.xp, gold: c.gold,
          kills: c.kills, items: c.items, gear: c.gear, quest: c.quest, extra: c.extra,
        })),
      };
    }
    const acc = this.jsonAccounts.find((a) => a.name.toLowerCase() === key);
    if (!acc) return null;
    return { name: acc.name, passHash: acc.passHash, salt: acc.salt, isGM: isGMName(acc.name), characters: acc.characters.map(sanitizeChar) };
  },

  async saveAccount(acc) {
    if (!acc || !acc.name) return;
    if (this.mode === "postgres") {
      let id = acc.id;
      if (!id) {
        const r = await this.pool.query("SELECT id FROM accounts WHERE lower(name) = $1", [acc.name.toLowerCase()]);
        id = r.rows.length ? r.rows[0].id : null;
      }
      if (!id) {
        const r = await this.pool.query(
          "INSERT INTO accounts (name, pass_hash, salt, is_gm) VALUES ($1, $2, $3, $4) RETURNING id",
          [acc.name, acc.passHash || "", acc.salt || "", !!acc.isGM]
        );
        id = r.rows[0].id;
      } else {
        await this.pool.query(
          "UPDATE accounts SET pass_hash = $2, salt = $3, is_gm = $4 WHERE id = $1",
          [id, acc.passHash || "", acc.salt || "", !!acc.isGM]
        );
      }
      acc.id = id;
      // Replace characters wholesale (simple + safe for this scale).
      await this.pool.query("DELETE FROM characters WHERE account_id = $1", [id]);
      for (const ch of (acc.characters || []).map(sanitizeChar)) {
        await this.pool.query(
          "INSERT INTO characters (account_id, name, cls, level, xp, gold, kills, items, gear, quest, extra) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [id, ch.name, ch.cls, ch.level, ch.xp, ch.gold, ch.kills,
           JSON.stringify(ch.items), JSON.stringify(ch.gear), JSON.stringify(ch.quest), JSON.stringify(ch.extra || {})]
        );
      }
      return;
    }
    const idx = this.jsonAccounts.findIndex((a) => a.name.toLowerCase() === acc.name.toLowerCase());
    const clean = {
      name: acc.name, passHash: acc.passHash || "", salt: acc.salt || "",
      isGM: isGMName(acc.name), characters: (acc.characters || []).map(sanitizeChar),
    };
    if (idx >= 0) this.jsonAccounts[idx] = clean;
    else this.jsonAccounts.push(clean);
    this.jsonDirty = true;
    this.saveJson();
  },
};

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

/* ---------------- HTTP: sessions + API ---------------- */
const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Map(); // token -> { name, guest }
const guestAccounts = new Map(); // name -> { name, guest:true, characters: [] }
function newToken() { return crypto.randomBytes(24).toString("hex"); }
function accountFromToken(req) {
  const token = req.get("x-token") || "";
  return sessions.get(token) || null;
}
function validName(name) {
  return typeof name === "string" && name.trim().length >= 2 && name.trim().length <= 20;
}
function validPassword(pw) {
  return typeof pw === "string" && pw.length >= 4 && pw.length <= 64;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, mode: store.mode, players: players.size, game: "mmorpg-test", slice: 2 });
});

app.post("/api/register", async (req, res) => {
  try {
    const name = (req.body && req.body.name || "").trim();
    const password = req.body && req.body.password;
    if (!validName(name)) return res.json({ ok: false, error: "Account name must be 2–20 characters." });
    if (!validPassword(password)) return res.json({ ok: false, error: "Password must be at least 4 characters." });
    if (await store.getAccount(name)) return res.json({ ok: false, error: "That account name is taken." });
    const salt = crypto.randomBytes(16).toString("hex");
    const acc = { name, passHash: hashPassword(password, salt), salt, isGM: isGMName(name), characters: [] };
    await store.saveAccount(acc);
    const token = newToken();
    sessions.set(token, { name, guest: false });
    res.json({ ok: true, token, account: { name, guest: false, isGM: acc.isGM } });
  } catch (e) {
    console.log("[api] register failed: " + (e && e.message ? e.message : e));
    res.json({ ok: false, error: "Registration failed. Try again." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const name = (req.body && req.body.name || "").trim();
    const password = req.body && req.body.password;
    if (!validName(name)) return res.json({ ok: false, error: "Enter your account name." });
    const acc = await store.getAccount(name);
    if (!acc) return res.json({ ok: false, error: "No account with that name — create one first." });
    if (!acc.passHash || hashPassword(password || "", acc.salt) !== acc.passHash) {
      return res.json({ ok: false, error: "Wrong password." });
    }
    const token = newToken();
    sessions.set(token, { name: acc.name, guest: false });
    res.json({ ok: true, token, account: { name: acc.name, guest: false, isGM: isGMName(acc.name) } });
  } catch (e) {
    console.log("[api] login failed: " + (e && e.message ? e.message : e));
    res.json({ ok: false, error: "Login failed. Try again." });
  }
});

app.post("/api/guest", (req, res) => {
  const name = "Guest-" + randi(1000, 9999);
  const acc = { name, guest: true, characters: [] };
  guestAccounts.set(name, acc);
  const token = newToken();
  sessions.set(token, { name, guest: true });
  res.json({ ok: true, token, account: { name, guest: true, isGM: false } });
});

async function loadSessionAccount(req) {
  const sess = accountFromToken(req);
  if (!sess) return null;
  if (sess.guest) return guestAccounts.get(sess.name) || null;
  return store.getAccount(sess.name);
}

app.get("/api/characters", async (req, res) => {
  const acc = await loadSessionAccount(req);
  if (!acc) return res.json({ ok: false, error: "Not logged in." });
  // a character that is online right now reports its live state (gold, xp,
  // level, items) — the stored copy only catches up on save
  const live = {};
  players.forEach((p) => { if (p.accountName === acc.name) live[p.char.name] = p.char; });
  res.json({ ok: true, characters: (acc.characters || []).map((c) => sanitizeChar(live[c.name] || c)) });
});

app.post("/api/characters", async (req, res) => {
  try {
    const sess = accountFromToken(req);
    if (!sess) return res.json({ ok: false, error: "Not logged in." });
    const name = (req.body && req.body.name || "").trim();
    const cls = req.body && req.body.cls;
    if (name.length < 2 || name.length > 16) return res.json({ ok: false, error: "Name must be 2–16 characters." });
    if (!/^[A-Za-z0-9 ]+$/.test(name)) return res.json({ ok: false, error: "Use letters, numbers and spaces only." });
    if (!CLASSES[cls]) return res.json({ ok: false, error: "Pick a class." });
    const acc = await loadSessionAccount(req);
    if (!acc) return res.json({ ok: false, error: "Not logged in." });
    if ((acc.characters || []).length >= 6) return res.json({ ok: false, error: "Character slots are full (6)." });
    if ((acc.characters || []).some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return res.json({ ok: false, error: "You already have a character with that name." });
    }
    const ch = newCharacter(name, cls);
    acc.characters.push(ch);
    if (!sess.guest) await store.saveAccount(acc);
    res.json({ ok: true, character: ch });
  } catch (e) {
    console.log("[api] create character failed: " + (e && e.message ? e.message : e));
    res.json({ ok: false, error: "Could not create character." });
  }
});

app.delete("/api/characters/:name", async (req, res) => {
  try {
    const sess = accountFromToken(req);
    if (!sess) return res.json({ ok: false, error: "Not logged in." });
    const acc = await loadSessionAccount(req);
    if (!acc) return res.json({ ok: false, error: "Not logged in." });
    const before = (acc.characters || []).length;
    acc.characters = (acc.characters || []).filter((c) => c.name.toLowerCase() !== String(req.params.name || "").toLowerCase());
    if (acc.characters.length === before) return res.json({ ok: false, error: "No such character." });
    if (!sess.guest) await store.saveAccount(acc);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: "Could not delete character." });
  }
});

/* ---------------- game state ---------------- */
const players = new Map(); // ws -> player
let enemies = [];          // server-owned
let tamables = [];         // wild pets hunters can tame {id, kind, name, x, y, r, wanderA, wanderT, homeX, homeY}
let nextTamableId = 1;
let friendlies = [];       // summoned NPCs {id, kind, owner, x, y, face, atkCd, moving}
let nextEnemyId = 1;
let nextFriendlyId = 1;
let nextPlayerId = 1;
let serverStart = Date.now();
const WILD_TARGET = 14;

function spawnSpot() {
  let x = 0, y = 0, tries = 0;
  do {
    x = rand(1120, WORLD.w - 90); y = rand(90, WORLD.h - 90);
    tries++;
  } while (tries < 24 && (dist(x, y, VILLAGE.x, VILLAGE.y) < VILLAGE.r + 170 || dist(x, y, 1980, 1420) < 250 || dist(x, y, CITY.x, CITY.y) < CITY.r + 170 || inRiver(x, y)));
  return { x, y };
}
function makeEnemy(type, x, y, opts) {
  opts = opts || {};
  const lvl = opts.level || 1;
  const hpMul = opts.hpMul || 1, dmgMul = opts.dmgMul || 1;
  const baseHp = Math.round(type.hp * (1 + (lvl - 1) * 0.22) * hpMul);
  const sc = opts.scale || 1;
  return {
    id: nextEnemyId++, kind: type.kind, name: opts.name || type.name, x, y,
    r: (type.kind === "slime" ? 15 : 16) * sc,
    hp: baseHp, maxHp: baseHp,
    dmg: Math.round((type.dmg + (lvl - 1)) * dmgMul),
    speed: type.speed,
    xp: Math.round(type.xp * (opts.xpMul || 1)),
    goldMin: Math.round(type.goldMin * (opts.goldMul || 1)),
    goldMax: Math.round(type.goldMax * (opts.goldMul || 1)),
    aggro: opts.aggro || type.aggro, atkCd: rand(0.2, 0.8),
    wanderA: rand(0, Math.PI * 2), wanderT: rand(1, 3),
    homeX: x, homeY: y, scale: sc, boss: !!opts.boss, lastHitBy: null,
  };
}
function spawnWildEnemy() {
  const type = ENEMY_TYPES[randi(0, ENEMY_TYPES.length - 1)];
  const s = spawnSpot();
  enemies.push(makeEnemy(type, s.x, s.y, {}));
}
// City building footprints (mirrors the client map) — nothing wild spawns inside one.
const CITY_BUILDINGS = [
  { x: 3280, y: 600, w: 150, h: 110 }, { x: 3680, y: 600, w: 170, h: 120 },
  { x: 3280, y: 1080, w: 140, h: 100 }, { x: 3130, y: 560, w: 130, h: 100 },
  { x: 3820, y: 1120, w: 140, h: 110 }, { x: 3150, y: 1260, w: 130, h: 100 },
  { x: 3720, y: 330, w: 140, h: 100 }, { x: 3400, y: 330, w: 130, h: 100 },
];
function inCityBuilding(x, y) {
  for (const b of CITY_BUILDINGS) {
    if (x >= b.x - 10 && x <= b.x + b.w + 10 && y >= b.y - 10 && y <= b.y + b.h + 10) return true;
  }
  return false;
}
function tamableSpot(type) {
  // Road hawks along the Old Road, river otters on the west bank (outside
  // the city safe zone), city foxes on the city outskirts.
  let x = 0, y = 0, tries = 0;
  do {
    if (type.region === "river") { x = rand(3830, 3960); y = rand(220, 1580); }
    else if (type.region === "road") { x = rand(2620, 2980); y = rand(700, 1100); }
    else { x = rand(3050, 3900); y = rand(260, 1540); }
    tries++;
  } while (tries < 30 && (inSafeZone(x, y) || inRiver(x, y) || inCityBuilding(x, y)));
  return { x, y };
}
function spawnTamable() {
  const type = TAMABLE_TYPES[randi(0, TAMABLE_TYPES.length - 1)];
  const s = tamableSpot(type);
  tamables.push({
    id: nextTamableId++, kind: type.kind, name: type.name, x: s.x, y: s.y,
    r: 13, wanderA: rand(0, Math.PI * 2), wanderT: rand(1, 3), homeX: s.x, homeY: s.y,
  });
}
function summonSpotNear(x, y) {
  const a = rand(0, Math.PI * 2);
  let sx = x + Math.cos(a) * 130, sy = y + Math.sin(a) * 130;
  if (inSafeZone(sx, sy)) {
    const d = dist(sx, sy, VILLAGE.x, VILLAGE.y) || 1;
    sx = VILLAGE.x + (sx - VILLAGE.x) / d * (VILLAGE.r + 70);
    sy = VILLAGE.y + (sy - VILLAGE.y) / d * (VILLAGE.r + 70);
  }
  return { x: clamp(sx, 40, WORLD.w - 40), y: clamp(sy, 40, WORLD.h - 40) };
}
function guardPos(i, nowMs) {
  const elapsed = (nowMs - serverStart) / 1000;
  if (i >= 3) { // city guards patrol the City edge (two of them)
    const angle = Math.PI * (i - 3) + elapsed * 0.05;
    return {
      x: CITY.x + Math.cos(angle) * (CITY.r - 6),
      y: CITY.y + Math.sin(angle) * (CITY.r - 6) * 0.92,
      face: Math.cos(angle + 0.4) >= 0 ? 1 : -1,
    };
  }
  const angle = (Math.PI * 2 / 3) * i + elapsed * 0.055;
  return {
    x: VILLAGE.x + Math.cos(angle) * (VILLAGE.r - 6),
    y: VILLAGE.y + Math.sin(angle) * (VILLAGE.r - 6) * 0.92,
    face: Math.cos(angle + 0.4) >= 0 ? 1 : -1,
  };
}
const guardCd = [0, 0, 0, 0, 0];

function publicEnemy(e) {
  return { id: e.id, kind: e.kind, name: e.name, x: Math.round(e.x), y: Math.round(e.y), hp: e.hp, maxHp: e.maxHp, scale: e.scale, boss: e.boss };
}
function publicPlayer(p) {
  const st = classStats(p.char);
  return {
    id: p.id, name: p.char.name, cls: p.char.cls, level: p.char.level,
    x: Math.round(p.x), y: Math.round(p.y), face: p.face, moving: p.moving,
    hp: Math.ceil(p.hp), maxHp: st.maxHp, dead: p.dead,
    pet: p.pet ? { x: Math.round(p.pet.x), y: Math.round(p.pet.y), hp: Math.ceil(p.pet.hp), maxHp: p.pet.maxHp, level: p.char.level } : null,
    tamed: (p.tamed || []).map((t) => ({ type: t.type, name: t.name, level: p.char.level, x: Math.round(t.x), y: Math.round(t.y), hp: Math.ceil(t.hp), maxHp: t.maxHp })),
  };
}
function send(ws, msg) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch (e) { /* socket gone */ }
}
function sendChar(p) {
  const st = classStats(p.char);
  send(p.ws, {
    t: "char",
    char: {
      name: p.char.name, cls: p.char.cls, level: p.char.level, xp: p.char.xp,
      gold: p.char.gold, kills: p.char.kills, items: p.char.items, gear: p.char.gear,
      quest: p.char.quest, extra: p.char.extra, hp: Math.ceil(p.hp), maxHp: st.maxHp,
    },
  });
  p.dirty = true;
}
function gainXpServer(p, amount) {
  const ch = p.char;
  ch.xp += amount;
  while (ch.xp >= xpNeed(ch.level) && ch.level < LEVEL_CAP) {
    ch.xp -= xpNeed(ch.level);
    ch.level++;
    const st = classStats(ch);
    p.hp = st.maxHp;
    if (p.pet) { p.pet.maxHp = 80 + (ch.level - 1) * 10; p.pet.hp = p.pet.maxHp; }
  }
  if (ch.level >= LEVEL_CAP) ch.xp = 0; // player cap — only a GM set-level goes past 60
}
function killEnemyServer(e, killer) {
  const idx = enemies.indexOf(e);
  if (idx >= 0) enemies.splice(idx, 1);
  if (!killer) return;
  const ch = killer.char;
  ch.kills++;
  const gold = randi(e.goldMin, e.goldMax);
  ch.gold += gold;
  gainXpServer(killer, e.xp);
  if (ch.quest.state === "active") {
    ch.quest.kills = Math.min(QUEST_NEED, ch.quest.kills + 1);
    if (ch.quest.kills >= QUEST_NEED) ch.quest.state = "ready";
  }
  send(killer.ws, { t: "kill", id: e.id, xp: e.xp, gold });
  sendChar(killer);
  // Keep the wilds populated (bosses/elites are one-offs, wilds respawn).
  if (!e.boss && enemies.filter((x) => !x.boss).length < WILD_TARGET) {
    setTimeout(() => { if (enemies.filter((x) => !x.boss).length < WILD_TARGET) spawnWildEnemy(); }, 2600);
  }
}

/* ---------------- tick: server-owned world ---------------- */
function tick() {
  const now = Date.now();
  const dt = 0.1;
  // --- enemies: wander, chase, attack ---
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.atkCd > 0) e.atkCd -= dt;
    // nearest live, non-safe player
    let target = null, best = Infinity;
    for (const p of players.values()) {
      if (p.dead) continue;
      if (inSafeZone(p.x, p.y)) continue;
      const d = dist(e.x, e.y, p.x, p.y);
      if (d < e.aggro && d < best) { best = d; target = p; }
    }
    if (target) {
      const dP = dist(e.x, e.y, target.x, target.y);
      if (dP > e.r + 16 + 2) {
        e.x += (target.x - e.x) / dP * e.speed * dt;
        e.y += (target.y - e.y) / dP * e.speed * dt;
      } else if (e.atkCd <= 0) {
        e.atkCd = 1.1;
        hurtPlayerServer(target, e.dmg);
      }
    } else {
      e.wanderT -= dt;
      if (e.wanderT <= 0) { e.wanderT = rand(1.5, 3.5); e.wanderA = rand(0, Math.PI * 2); }
      const wx = e.x + Math.cos(e.wanderA) * e.speed * 0.32 * dt;
      const wy = e.y + Math.sin(e.wanderA) * e.speed * 0.32 * dt;
      if (!inSafeZone(wx, wy) && dist(wx, wy, VILLAGE.x, VILLAGE.y) > VILLAGE.r + 26) { e.x = wx; e.y = wy; }
      else e.wanderA += Math.PI * 0.7;
      const dH = dist(e.x, e.y, e.homeX, e.homeY);
      if (dH > 300) { e.x += (e.homeX - e.x) / dH * e.speed * 0.5 * dt; e.y += (e.homeY - e.y) / dH * e.speed * 0.5 * dt; }
    }
    e.x = clamp(e.x, 30, WORLD.w - 30);
    e.y = clamp(e.y, 30, WORLD.h - 30);
  }
  // --- guards patrol the village edge and the City edge, and shoot anything close ---
  for (let gi = 0; gi < 5; gi++) {
    const gp = guardPos(gi, now);
    guardCd[gi] -= dt;
    if (guardCd[gi] > 0) continue;
    let foe = null, bd = 265;
    for (const e of enemies) {
      const d = dist(gp.x, gp.y, e.x, e.y);
      if (d < bd) { bd = d; foe = e; }
    }
    if (foe) {
      guardCd[gi] = 0.85;
      foe.hp -= 16;
      foe.lastHitBy = null; // guard kills pay nobody
      if (foe.hp <= 0) killEnemyServer(foe, null);
    }
  }
  // --- summoned friendly NPCs ---
  for (let i = friendlies.length - 1; i >= 0; i--) {
    const fr = friendlies[i];
    const owner = fr.owner;
    if (!owner || !players.has(owner.ws)) { friendlies.splice(i, 1); continue; }
    if (fr.kind === "merchant") continue;
    fr.atkCd -= dt;
    if (fr.kind === "guard") {
      let foe = null, bd = 260;
      for (const e of enemies) {
        const d = dist(fr.x, fr.y, e.x, e.y);
        if (d < bd) { bd = d; foe = e; }
      }
      const tx = foe ? foe.x : owner.x - owner.face * 48;
      const ty = foe ? foe.y : owner.y + 42;
      const fd = dist(fr.x, fr.y, tx, ty);
      const stopD = foe ? foe.r + 62 : 16;
      fr.moving = fd > stopD;
      if (fr.moving && fd > 0.01) {
        fr.x += (tx - fr.x) / fd * 198 * dt;
        fr.y += (ty - fr.y) / fd * 198 * dt;
        fr.face = tx >= fr.x ? 1 : -1;
      }
      if (foe && fd < 250 && fr.atkCd <= 0) {
        fr.atkCd = 0.9;
        foe.hp -= 14;
        foe.lastHitBy = owner;
        if (foe.hp <= 0) killEnemyServer(foe, owner);
      }
    } else if (fr.kind === "healer") {
      const tx = owner.x - owner.face * 48, ty = owner.y + 42;
      const fd = dist(fr.x, fr.y, tx, ty);
      fr.moving = fd > 16;
      if (fr.moving && fd > 0.01) {
        fr.x += (tx - fr.x) / fd * 198 * dt;
        fr.y += (ty - fr.y) / fd * 198 * dt;
        fr.face = tx >= fr.x ? 1 : -1;
      }
      if (fr.atkCd <= 0) {
        fr.atkCd = 3;
        const st = classStats(owner.char);
        if (!owner.dead && owner.hp < st.maxHp) {
          owner.hp = Math.min(st.maxHp, owner.hp + Math.round(st.maxHp * 0.08));
          sendChar(owner);
        }
        if (owner.pet && owner.pet.hp < owner.pet.maxHp) {
          owner.pet.hp = Math.min(owner.pet.maxHp, owner.pet.hp + Math.round(owner.pet.maxHp * 0.1));
        }
      }
    }
  }
  // --- regen ---
  for (const p of players.values()) {
    if (p.dead) continue;
    const st = classStats(p.char);
    const safe = inSafeZone(p.x, p.y);
    if (safe) p.hp = Math.min(st.maxHp, p.hp + st.maxHp * 0.09 * dt);
    else if (now - p.lastHurt > 5000) p.hp = Math.min(st.maxHp, p.hp + st.maxHp * 0.02 * dt);
    if (p.pet && inSafeZone(p.pet.x, p.pet.y)) {
      p.pet.hp = Math.min(p.pet.maxHp, p.pet.hp + p.pet.maxHp * 0.09 * dt);
    }
    if (p.pet) p.pet.hp = Math.max(1, p.pet.hp); // Fang never dies — he limps back to you
  }
  // --- wild respawn maintenance ---
  if (enemies.filter((e) => !e.boss).length < WILD_TARGET) spawnWildEnemy();
  // --- tamable pets: wander their home ground, never fight, never enter safe zones ---
  for (let i = tamables.length - 1; i >= 0; i--) {
    const t = tamables[i];
    t.wanderT -= dt;
    if (t.wanderT <= 0) { t.wanderT = rand(1.5, 3.5); t.wanderA = rand(0, Math.PI * 2); }
    const type = TAMABLE_TYPES.find((x) => x.kind === t.kind) || TAMABLE_TYPES[0];
    const wx = t.x + Math.cos(t.wanderA) * type.speed * 0.3 * dt;
    const wy = t.y + Math.sin(t.wanderA) * type.speed * 0.3 * dt;
    if (!inSafeZone(wx, wy) && !inRiver(wx, wy) && !inCityBuilding(wx, wy)) { t.x = wx; t.y = wy; }
    else t.wanderA += Math.PI * 0.7;
    const dH = dist(t.x, t.y, t.homeX, t.homeY);
    if (dH > 320) { t.x += (t.homeX - t.x) / dH * type.speed * 0.45 * dt; t.y += (t.homeY - t.y) / dH * type.speed * 0.45 * dt; }
    t.x = clamp(t.x, 30, WORLD.w - 30);
    t.y = clamp(t.y, 30, WORLD.h - 30);
  }
  if (tamables.length < TAMABLE_TARGET) spawnTamable();
}
function hurtPlayerServer(p, dmg) {
  if (p.dead || inSafeZone(p.x, p.y)) return;
  p.hp -= dmg;
  p.lastHurt = Date.now();
  if (p.hp <= 0) {
    p.hp = 0;
    p.dead = true;
    send(p.ws, { t: "dead" });
    for (const e of enemies) { if (e.lastHitBy === p) e.lastHitBy = null; }
  }
  sendChar(p);
}
function broadcastSnap() {
  const now = Date.now();
  const plist = [];
  for (const p of players.values()) plist.push(publicPlayer(p));
  const snap = {
    t: "snap",
    players: plist,
    enemies: enemies.map(publicEnemy),
    tamables: tamables.map((t) => ({ id: t.id, kind: t.kind, name: t.name, x: Math.round(t.x), y: Math.round(t.y) })),
    guards: [0, 1, 2, 3, 4].map((i) => guardPos(i, now)),
    friendlies: friendlies.map((fr) => ({ id: fr.id, kind: fr.kind, x: Math.round(fr.x), y: Math.round(fr.y), face: fr.face, owner: fr.owner.char.name })),
  };
  const raw = JSON.stringify(snap);
  for (const p of players.values()) {
    try { if (p.ws.readyState === 1) p.ws.send(raw); } catch (e) { /* ignore */ }
  }
}
function broadcastChat(from, cls, text) {
  const raw = JSON.stringify({ t: "chat", from, cls, text, ts: Date.now() });
  for (const p of players.values()) {
    try { if (p.ws.readyState === 1) p.ws.send(raw); } catch (e) { /* ignore */ }
  }
}

/* ---------------- WebSocket ---------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function findPlayerByCharName(name) {
  const key = String(name || "").toLowerCase();
  for (const p of players.values()) {
    if (p.char.name.toLowerCase() === key) return p;
  }
  return null;
}

wss.on("connection", (ws) => {
  let player = null;
  let joinTimer = setTimeout(() => { try { ws.close(); } catch (e) { /* ignore */ } }, 8000);

  ws.on("message", (data) => {
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    if (!msg || typeof msg.t !== "string") return;

    // ---- join handshake (first message) ----
    if (!player) {
      if (msg.t !== "join") return;
      clearTimeout(joinTimer);
      joinTimer = null;
      const sess = sessions.get(String(msg.token || ""));
      if (!sess) { send(ws, { t: "error", message: "Session expired — log in again." }); return ws.close(); }
      (async () => {
        try {
          const acc = sess.guest ? guestAccounts.get(sess.name) : await store.getAccount(sess.name);
          if (!acc) { send(ws, { t: "error", message: "Account not found — log in again." }); return ws.close(); }
          const ch = (acc.characters || []).find((c) => c.name === String(msg.char || ""));
          if (!ch) { send(ws, { t: "error", message: "Character not found." }); return ws.close(); }
          const st = classStats(ch);
          // Log back in where you left off: village well, the Old Road, or the City gate.
          const spawn = ch.extra && ch.extra.zone === "city" ? { x: CITY_GATE.x + 40, y: CITY_GATE.y }
            : ch.extra && ch.extra.zone === "road" ? { x: 2700, y: 900 }
            : { x: VILLAGE.x + 30, y: VILLAGE.y + 120 };
          player = {
            id: nextPlayerId++, ws, token: msg.token, accountName: acc.name, guest: !!sess.guest,
            isGM: isGMName(acc.name),
            char: ch,
            x: spawn.x, y: spawn.y, face: 1, moving: false,
            hp: st.maxHp, lastHurt: 0, lastAtk: 0, lastPetAtk: 0,
            lastPos: { x: spawn.x, y: spawn.y, at: Date.now() },
            lastChat: 0, lastFish: 0, dead: false, dirty: false,
            pet: ch.cls === "hunter"
              ? { x: spawn.x - 60, y: spawn.y + 30, hp: 80 + (ch.level - 1) * 10, maxHp: 80 + (ch.level - 1) * 10 }
              : null,
            tamed: (ch.extra && ch.extra.pets || []).map((pt) => ({
              type: pt.type, name: pt.name,
              x: spawn.x - 60 - Math.random() * 40, y: spawn.y + 60 + Math.random() * 30,
              hp: 60 + (ch.level - 1) * 8, maxHp: 60 + (ch.level - 1) * 8, lastAtk: 0,
            })),
          };
          players.set(ws, player);
          send(ws, {
            t: "welcome",
            you: publicPlayer(player),
            catalog: {
              shop: SHOP_CATALOG.map((id) => ({ id, ...ITEMS[id] })),
              armory: ARMORY_CATALOG.map((id) => ({ id, ...GEAR[id] })),
              cityshop: CITY_SHOP_CATALOG.map((id) => ({ id, ...ITEMS[id] })),
              cityarmory: CITY_ARMORY_CATALOG.map((id) => ({ id, ...GEAR[id] })),
              fishshop: FISH_CATALOG.map((id) => ({ id, ...ITEMS[id] })),
            },
          });
          sendChar(player);
          broadcastChat("System", "", player.char.name + " has entered Dawnhollow Vale.");
        } catch (e) {
          console.log("[ws] join failed: " + (e && e.message ? e.message : e));
          send(ws, { t: "error", message: "Could not join the world." });
          try { ws.close(); } catch (e2) { /* ignore */ }
        }
      })();
      return;
    }

    // ---- in-world messages ----
    try {
      if (msg.t === "pos") handlePos(player, msg);
      else if (msg.t === "atk") handleAttack(player, msg);
      else if (msg.t === "chat") handleChat(player, msg);
      else if (msg.t === "quest") handleQuest(player, msg);
      else if (msg.t === "quest2") handleQuest2(player, msg);
      else if (msg.t === "quest3") handleQuest3(player, msg);
      else if (msg.t === "tame") handleTame(player, msg);
      else if (msg.t === "fish") handleFish(player);
      else if (msg.t === "respawn") handleRespawn(player);
      else if (msg.t === "shop") handleShop(player, msg);
      else if (msg.t === "gm") handleGm(player, msg);
      else if (msg.t === "leave") { /* client is leaving; close handled by socket close */ }
    } catch (e) {
      console.log("[ws] handler error (" + msg.t + "): " + (e && e.message ? e.message : e));
    }
  });

  ws.on("close", () => {
    if (joinTimer) clearTimeout(joinTimer);
    if (!player) return;
    players.delete(ws);
    for (let i = friendlies.length - 1; i >= 0; i--) {
      if (friendlies[i].owner === player) friendlies.splice(i, 1);
    }
    savePlayerChar(player);
    broadcastChat("System", "", player.char.name + " has left Dawnhollow Vale.");
    player = null;
  });
  ws.on("error", () => { /* socket errors are terminal; close handler cleans up */ });
});

function handlePos(p, msg) {
  let nx = clamp(Number(msg.x) || p.x, 24, WORLD.w - 24);
  let ny = clamp(Number(msg.y) || p.y, 24, WORLD.h - 24);
  // The river is water, not walkable — push back to the west bank.
  if (inRiver(nx, ny)) nx = RIVER.x0 - 24;
  // Anti-teleport: allow whatever the player could legitimately have walked
  // since their last accepted position, plus a margin. A fast joystick
  // sprint can never trip this — only an impossible jump inside a short
  // window is dropped. And any position is accepted once a full second has
  // passed since the last accepted one, so a dropped update can never
  // strand a legitimate player (their next reports re-sync the server).
  const now = Date.now();
  const dtMs = Math.max(0, now - p.lastPos.at);
  const st = classStats(p.char);
  const allowed = Math.max(500, st.speed * (Math.min(dtMs, 2000) / 1000) + 150);
  const d = dist(nx, ny, p.lastPos.x, p.lastPos.y);
  if (d > allowed && dtMs < 1000) return;
  p.x = nx; p.y = ny;
  p.face = msg.face === -1 ? -1 : 1;
  p.moving = !!msg.moving;
  p.lastPos = { x: nx, y: ny, at: now };
  if (p.char.extra) {
    const z = zoneOf(nx, ny);
    if (p.char.extra.zone !== z) { p.char.extra.zone = z; p.dirty = true; }
  }
  if (msg.pet && p.pet) {
    p.pet.x = clamp(Number(msg.pet.x) || p.pet.x, 24, WORLD.w - 24);
    p.pet.y = clamp(Number(msg.pet.y) || p.pet.y, 24, WORLD.h - 24);
  }
  if (Array.isArray(msg.tamed) && p.tamed) {
    msg.tamed.forEach((tp, i) => {
      const t = p.tamed[i];
      if (!t || !tp) return;
      t.x = clamp(Number(tp.x) || t.x, 24, WORLD.w - 24);
      t.y = clamp(Number(tp.y) || t.y, 24, WORLD.h - 24);
    });
  }
}

function handleAttack(p, msg) {
  if (p.dead) return;
  const e = enemies.find((x) => x.id === Number(msg.id));
  if (!e) return;
  const now = Date.now();
  const fromPet = msg.from === "pet";
  if (fromPet) {
    if (!p.pet) return;
    if (now - p.lastPetAtk < 800) return;
    if (dist(p.pet.x, p.pet.y, e.x, e.y) > 250 + e.r) return;
    p.lastPetAtk = now;
    const dmg = Math.round((5 + (p.char.level - 1)) * rand(0.85, 1.2));
    e.hp -= dmg;
    e.lastHitBy = p;
    send(p.ws, { t: "hit", id: e.id, dmg, crit: false, from: "pet" });
  } else if (msg.from === "tamed") {
    const t = p.tamed && p.tamed[Number(msg.petIdx) || 0];
    if (!t) return;
    if (now - (t.lastAtk || 0) < 800) return;
    if (dist(t.x, t.y, e.x, e.y) > 250 + e.r) return;
    t.lastAtk = now;
    const dmg = Math.round((5 + (p.char.level - 1)) * rand(0.85, 1.2));
    e.hp -= dmg;
    e.lastHitBy = p;
    send(p.ws, { t: "hit", id: e.id, dmg, crit: false, from: "tamed" });
  } else {
    const st = classStats(p.char);
    if (now - p.lastAtk < st.atkRate * 1000) return;
    if (dist(p.x, p.y, e.x, e.y) > st.range + e.r + 60) return;
    p.lastAtk = now;
    const crit = Math.random() < 0.15;
    const dmg = Math.round(st.dmg * rand(0.85, 1.15) * (crit ? 1.8 : 1));
    e.hp -= dmg;
    e.lastHitBy = p;
    send(p.ws, { t: "hit", id: e.id, dmg, crit, from: "player" });
  }
  if (e.hp <= 0) killEnemyServer(e, p);
}

function handleChat(p, msg) {
  const now = Date.now();
  if (now - p.lastChat < 1000) return; // 1 message per second
  p.lastChat = now;
  const text = String(msg.text || "").trim().slice(0, 200);
  if (!text) return;
  broadcastChat(p.char.name, p.char.cls, text);
}

function handleQuest(p, msg) {
  const q = p.char.quest;
  if (msg.action === "accept" && q.state === "none") {
    q.state = "active"; q.kills = 0;
    sendChar(p);
    send(p.ws, { t: "questResult", ok: true, action: "accept" });
  } else if (msg.action === "claim" && q.state === "ready") {
    q.state = "done";
    p.char.gold += 40;
    gainXpServer(p, 60);
    sendChar(p);
    send(p.ws, { t: "questResult", ok: true, action: "claim", gold: 40, xp: 60 });
  } else {
    send(p.ws, { t: "questResult", ok: false, action: msg.action || "", error: "Nothing to do right now." });
  }
}

function handleTame(p, msg) {
  const fail = (error) => send(p.ws, { t: "tameResult", ok: false, error });
  if (p.dead) return fail("You are dead.");
  if (p.char.cls !== "hunter") return fail("Only Hunters can tame pets.");
  if (!p.char.extra) p.char.extra = sanitizeExtra({});
  const ex = p.char.extra;
  if (ex.pets.length >= 2) return fail("You already have two tamed pets.");
  const t = tamables.find((x) => x.id === Number(msg.id));
  if (!t) return fail("That pet is gone.");
  if (dist(p.x, p.y, t.x, t.y) > 130) return fail("Get closer to tame it.");
  const type = TAMABLE_TYPES.find((x) => x.kind === t.kind) || TAMABLE_TYPES[0];
  ex.pets.push({ type: t.kind, name: t.name });
  const idx = tamables.indexOf(t);
  if (idx >= 0) tamables.splice(idx, 1);
  p.tamed.push({
    type: t.kind, name: t.name,
    x: p.x - 40, y: p.y + 50,
    hp: 60 + (p.char.level - 1) * 8, maxHp: 60 + (p.char.level - 1) * 8, lastAtk: 0,
  });
  p.dirty = true;
  sendChar(p);
  send(p.ws, { t: "tameResult", ok: true, pet: { type: t.kind, name: t.name, icon: type.icon } });
  setTimeout(() => { if (tamables.length < TAMABLE_TARGET) spawnTamable(); }, 8000);
}
function rollFish() {
  const r = Math.random();
  if (r < 0.55) return "trout";
  if (r < 0.85) return "silverfin";
  if (r < 0.97) return "carp";
  return "boot";
}
function handleFish(p) {
  const fail = (error) => send(p.ws, { t: "fishResult", ok: false, error });
  if (p.dead) return fail("You are dead.");
  const now = Date.now();
  if (now - (p.lastFish || 0) < 4000) return fail("Wait a moment before casting again.");
  const near = FISH_SPOTS.some((s) => dist(p.x, p.y, s.x, s.y) < 110);
  if (!near) return fail("Stand by the river to fish.");
  p.lastFish = now;
  const id = rollFish();
  const found = p.char.items.find((it) => !it.gear && it.id === id);
  if (found) found.qty = (found.qty || 0) + 1;
  else p.char.items.push({ id, qty: 1 });
  const ex = p.char.extra;
  if (ex && ex.quest2 && ex.quest2.state === "active") {
    ex.quest2.count = Math.min(3, (ex.quest2.count || 0) + 1);
    if (ex.quest2.count >= 3) ex.quest2.state = "ready";
  }
  p.dirty = true;
  sendChar(p);
  send(p.ws, { t: "fishResult", ok: true, id, name: FISH[id].name, icon: FISH[id].icon });
}
function handleQuest2(p, msg) {
  const q = p.char.extra && p.char.extra.quest2;
  if (!q) return;
  if (msg.action === "accept" && q.state === "none") {
    q.state = "active"; q.count = 0;
    p.dirty = true; sendChar(p);
    send(p.ws, { t: "questResult", ok: true, action: "accept", quest: "fish" });
  } else if (msg.action === "claim" && q.state === "ready") {
    q.state = "done";
    p.char.gold += 50;
    gainXpServer(p, 80);
    p.dirty = true; sendChar(p);
    send(p.ws, { t: "questResult", ok: true, action: "claim", quest: "fish", gold: 50, xp: 80 });
  } else {
    send(p.ws, { t: "questResult", ok: false, action: msg.action || "", quest: "fish", error: "Nothing to do right now." });
  }
}
function handleQuest3(p, msg) {
  const q = p.char.extra && p.char.extra.quest3;
  if (!q) return;
  if (msg.action === "accept" && q.state === "none") {
    q.state = "active";
    p.dirty = true; sendChar(p);
    send(p.ws, { t: "questResult", ok: true, action: "accept", quest: "letter" });
  } else if (msg.action === "deliver" && q.state === "active") {
    if (dist(p.x, p.y, VILLAGE.x, VILLAGE.y) > VILLAGE.r) {
      return send(p.ws, { t: "questResult", ok: false, action: "deliver", quest: "letter", error: "Find Steward Halden in the village." });
    }
    q.state = "done";
    p.char.gold += 30;
    gainXpServer(p, 50);
    p.dirty = true; sendChar(p);
    send(p.ws, { t: "questResult", ok: true, action: "deliver", quest: "letter", gold: 30, xp: 50 });
  } else {
    send(p.ws, { t: "questResult", ok: false, action: msg.action || "", quest: "letter", error: "Nothing to do right now." });
  }
}
function handleRespawn(p) {
  if (!p.dead) return;
  p.dead = false;
  const st = classStats(p.char);
  p.hp = st.maxHp;
  p.x = VILLAGE.x + 30; p.y = VILLAGE.y + 120;
  p.lastPos = { x: p.x, y: p.y, at: Date.now() };
  if (p.pet) { p.pet.hp = p.pet.maxHp; p.pet.x = p.x - 50; p.pet.y = p.y + 26; }
  if (p.tamed) p.tamed.forEach((t, i) => { t.hp = t.maxHp; t.x = p.x - 50 - i * 30; t.y = p.y + 26 + i * 20; });
  send(p.ws, { t: "respawned", x: p.x, y: p.y, hp: p.hp });
  sendChar(p);
}

function handleShop(p, msg) {
  const ch = p.char;
  const fail = (error) => send(p.ws, { t: "shopResult", ok: false, error });
  const shopDef = SHOPS[String(msg.shop || "")];
  if (!shopDef) return fail("No such shop.");
  if (msg.action === "buy") {
    const id = String(msg.id || "");
    const qty = clamp(Math.floor(Number(msg.qty) || 1), 1, 99);
    if (shopDef.catalog.indexOf(id) < 0) return fail("That item is not sold here.");
    const def = shopDef.gear ? GEAR[id] : ITEMS[id];
    if (!def || !def.price) return fail("That item is not sold here.");
    const price = def.price * qty;
    if (ch.gold < price) return fail("Not enough gold — you need " + price + ".");
    if (shopDef.gear) {
      if (ch.items.some((it) => it.gear && it.id === id)) return fail("You already own that.");
      ch.items.push({ id, gear: true });
    } else {
      const found = ch.items.find((it) => !it.gear && it.id === id);
      if (found) found.qty = (found.qty || 0) + qty;
      else ch.items.push({ id, qty });
    }
    ch.gold -= price;
    sendChar(p);
    return send(p.ws, { t: "shopResult", ok: true, action: "buy", id, qty });
  }
  if (msg.action === "sell") {
    const id = String(msg.id || "");
    const idx = ch.items.findIndex((it) => it.id === id);
    if (idx < 0) return fail("You do not own that.");
    const it = ch.items[idx];
    const price = sellPrice(id);
    if (it.gear) {
      const gd = GEAR[id];
      if (gd && ch.gear[gd.slot] === id) ch.gear[gd.slot] = null;
      ch.items.splice(idx, 1);
    } else {
      it.qty = (it.qty || 1) - 1;
      if (it.qty <= 0) ch.items.splice(idx, 1);
    }
    ch.gold += price;
    sendChar(p);
    return send(p.ws, { t: "shopResult", ok: true, action: "sell", id, gold: price });
  }
  fail("Unknown shop action.");
}

function gmLogTo(p, text) {
  send(p.ws, { t: "gmLog", msg: text });
}
function handleGm(p, msg) {
  if (!p.isGM) {
    send(p.ws, { t: "gmResult", ok: false, error: "You are not a Game Master." });
    return;
  }
  const targetName = msg.target && msg.target !== "self" ? String(msg.target) : null;
  const target = targetName ? findPlayerByCharName(targetName) : p;
  const ch = target ? target.char : null;
  const done = (logMsg) => {
    gmLogTo(p, logMsg);
    if (target && target !== p) sendChar(target);
    sendChar(p);
  };
  switch (msg.action) {
    case "players":
      send(p.ws, { t: "gmPlayers", players: Array.from(players.values()).map((x) => x.char.name) });
      return;
    case "inspect": {
      if (!target) { send(p.ws, { t: "gmResult", ok: false, error: "Player not online." }); return; }
      const st = classStats(ch);
      send(p.ws, {
        t: "inspect",
        name: ch.name, cls: ch.cls, level: ch.level, xp: ch.xp, gold: ch.gold,
        kills: ch.kills, hp: Math.ceil(target.hp), maxHp: st.maxHp, dmg: st.dmg,
        speed: st.speed, items: ch.items, gear: ch.gear, quest: ch.quest,
        pets: (ch.extra && ch.extra.pets || []).map((pt) => pt.name),
      });
      return;
    }
    case "giveGold": {
      if (!target) { send(p.ws, { t: "gmResult", ok: false, error: "Player not online." }); return; }
      const amt = clamp(Math.floor(Number(msg.amount) || 0), 1, 100000000);
      ch.gold += amt;
      return done("Gave " + amt.toLocaleString() + " gold to " + ch.name + ". Total: " + ch.gold.toLocaleString() + ".");
    }
    case "giveGear": {
      if (!target || !GEAR[msg.id]) { send(p.ws, { t: "gmResult", ok: false, error: "Player not online, or no such gear." }); return; }
      const gd = GEAR[msg.id];
      if (!ch.items.some((it) => it.gear && it.id === msg.id)) ch.items.push({ id: msg.id, gear: true });
      if (msg.equip) ch.gear[gd.slot] = msg.id;
      return done("Gave " + gd.name + " to " + ch.name + (msg.equip ? " (equipped)" : "") + ".");
    }
    case "giveItem": {
      if (!target || !ITEMS[msg.id]) { send(p.ws, { t: "gmResult", ok: false, error: "Player not online, or no such item." }); return; }
      const qty = clamp(Math.floor(Number(msg.qty) || 1), 1, 99);
      const found = ch.items.find((it) => !it.gear && it.id === msg.id);
      if (found) found.qty = (found.qty || 0) + qty;
      else ch.items.push({ id: msg.id, qty });
      return done("Gave " + ITEMS[msg.id].name + " ×" + qty + " to " + ch.name + ".");
    }
    case "setLevel": {
      if (!target) { send(p.ws, { t: "gmResult", ok: false, error: "Player not online." }); return; }
      const n = clamp(Math.floor(Number(msg.level) || 1), 1, 999);
      ch.level = n; ch.xp = 0;
      const st = classStats(ch);
      target.hp = st.maxHp;
      if (target.pet) { target.pet.maxHp = 80 + (n - 1) * 10; target.pet.hp = target.pet.maxHp; }
      return done("Set " + ch.name + " to level " + n + (n > LEVEL_CAP ? " (past the 60 cap — GM bypass)" : "") + ".");
    }
    case "summon": {
      const spot = summonSpotNear(p.x, p.y);
      const T = ENEMY_TYPES;
      const add = (type, opts) => {
        const s = Math.random() < 0.5 ? spot : summonSpotNear(p.x, p.y);
        enemies.push(makeEnemy(type, s.x, s.y, opts));
      };
      const kind = String(msg.kind || "");
      if (kind === "wolfpack") { for (let i = 0; i < 3; i++) add(T[0]); gmLogTo(p, "Summoned a wolf pack ×3."); }
      else if (kind === "boar") { add(T[1]); gmLogTo(p, "Summoned a Wild Boar."); }
      else if (kind === "slime") { add(T[2]); gmLogTo(p, "Summoned a Thorn Slime."); }
      else if (kind === "elite-wolf") { add(T[0], { name: "Elite Vale Alpha", hpMul: 6, dmgMul: 2, xpMul: 5, goldMul: 5, scale: 1.35, aggro: 260 }); gmLogTo(p, "Summoned Elite Vale Alpha."); }
      else if (kind === "elite-boar") { add(T[1], { name: "Elite Thornback Brute", hpMul: 7, dmgMul: 2.2, xpMul: 5, goldMul: 6, scale: 1.4, aggro: 260 }); gmLogTo(p, "Summoned Elite Thornback Brute."); }
      else if (kind === "dungeon") { add(T[0], { name: "Gorefang", hpMul: 25, dmgMul: 3, xpMul: 20, goldMul: 25, scale: 1.8, aggro: 320, boss: true }); gmLogTo(p, "Summoned Gorefang, the Dungeon Boss."); }
      else if (kind === "raid") { add(T[2], { name: "Thornmaw the Ancient", hpMul: 80, dmgMul: 4, xpMul: 60, goldMul: 80, scale: 2.4, aggro: 360, boss: true }); gmLogTo(p, "Summoned Thornmaw the Ancient, the Raid Boss."); }
      else { send(p.ws, { t: "gmResult", ok: false, error: "Unknown summon." }); return; }
      sendChar(p);
      return;
    }
    case "summonFriend": {
      if (friendlies.filter((fr) => fr.owner === p).length >= 6) {
        send(p.ws, { t: "gmResult", ok: false, error: "You already have 6 summoned NPCs with you." });
        return;
      }
      const kind = String(msg.kind || "");
      if (["guard", "healer", "merchant"].indexOf(kind) < 0) {
        send(p.ws, { t: "gmResult", ok: false, error: "Unknown friendly." });
        return;
      }
      friendlies.push({ id: nextFriendlyId++, kind, owner: p, x: p.x + rand(-60, 60), y: p.y + rand(30, 70), face: 1, atkCd: 0, moving: false });
      const label = kind === "guard" ? "Guard Companion" : kind === "healer" ? "Wandering Healer" : "Traveling Merchant";
      gmLogTo(p, "Summoned friendly NPC: " + label + ".");
      sendChar(p);
      return;
    }
    default:
      send(p.ws, { t: "gmResult", ok: false, error: "Unknown GM action." });
  }
}

/* ---------------- persistence sweeps ---------------- */
async function savePlayerChar(p) {
  if (!p || p.guest) return; // guests are session-only
  try {
    const acc = await store.getAccount(p.accountName);
    if (!acc) return;
    const idx = acc.characters.findIndex((c) => c.name === p.char.name);
    if (idx >= 0) acc.characters[idx] = sanitizeChar(p.char);
    else acc.characters.push(sanitizeChar(p.char));
    await store.saveAccount(acc);
    p.dirty = false;
  } catch (e) {
    console.log("[save] failed for " + p.char.name + ": " + (e && e.message ? e.message : e));
  }
}
setInterval(() => {
  for (const p of players.values()) {
    if (p.dirty) savePlayerChar(p);
  }
}, 20000);

/* ---------------- startup ---------------- */
for (let s = 0; s < WILD_TARGET; s++) spawnWildEnemy();
for (let s = 0; s < TAMABLE_TARGET; s++) spawnTamable();
let tickCount = 0;
setInterval(() => {
  try { tick(); } catch (e) { console.log("[tick] " + (e && e.message ? e.message : e)); }
  tickCount++;
  try { broadcastSnap(); } catch (e) { console.log("[snap] " + (e && e.message ? e.message : e)); }
}, 100);

async function shutdown() {
  console.log("[server] shutting down — saving characters…");
  for (const p of players.values()) await savePlayerChar(p);
  if (store.mode === "json") store.saveJson();
  try { if (store.pool) await store.pool.end(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

store.init().then(() => {
  server.listen(PORT, () => {
    console.log("[server] MMORPG test slice 2 listening on :" + PORT + " (store: " + store.mode + ")");
  });
}).catch((e) => {
  console.log("[server] store init failed: " + (e && e.message ? e.message : e));
  process.exit(1);
});
