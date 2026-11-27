# MMORPG test — Dawnhollow Vale

A 2D fantasy idle MMORPG (top-down, browser-based) built in slices.
**Slice 1** was a single-player game in one HTML file. **Slice 2** adds
multiplayer: a Node.js server, live shared world over WebSocket, server
accounts + saved characters, world chat, NPC shops, an Armory, and a GM
console that works on other players.

The real game name is still TBD — "MMORPG test" is the placeholder title.

## What slice 2 adds

- **Shared world** — every player sees the same enemies, guards, friendlies,
  and each other (name plates, moving live). Server-owned enemies: wolves,
  boars, slimes, plus GM-summoned bosses and elites.
- **Server accounts** — register / log in with a password (scrypt-hashed) or
  play as a guest. Characters are saved on the server and survive closing
  the tab. Level cap 60; GMs can go past it.
- **World chat** — talk to everyone in the Vale.
- **Pet level visible** — Fang's level shows in the HUD pet bar and above
  Fang in the world (Fang grows with your level).
- **NPC shops** — Shopkeeper Bram in the village sells potions and
  consumables; sell items back for half price.
- **Armory** — Armorer Durn (stone building in the village) sells weapons
  and armor, and shows your currently equipped gear.
- **GM console, multiplayer** — inspect another online player (stats,
  inventory, money) and give them gear/gold. All slice 1 GM powers still
  work (OP gear set, gold, potions, summons incl. raid boss Thornmaw and
  dungeon boss Gorefang, set level past 60).
- **Offline fallback** — if the server can't be reached, the game plays
  exactly like slice 1 (local mode: local accounts, local enemies, local
  shops).

## Run locally

```bash
npm install
npm start
```

Then open http://localhost:3000 — no database needed. Without a
`DATABASE_URL`, accounts and characters are stored in `data/accounts.json`
(JSON fallback, same pattern as Galaxy Clicker).

Useful env vars:

| Var | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port |
| `DATA_DIR` | `./data` | Where the JSON fallback files live |
| `DATABASE_URL` | _(unset)_ | Postgres connection string (Neon) — when set, accounts/characters live in Postgres instead of JSON |
| `GM_ACCOUNTS` | `cody` | Comma-separated account names that are Game Masters |

Smoke test (starts its own server on a test port, two clients, chat,
combat, shop, GM give/inspect, save/load round-trip incl. a server
restart):

```bash
npm test
```

## Deploy (GitHub → Render → Neon)

1. **GitHub** — create the repo `mmorpg-test` and push this folder
   (same web-UI upload flow as Throne of Shadows; the repo has no
   credentials in it — `ADMIN_KEY`-style secrets are env vars only).
2. **Render** — New Web Service → connect the `mmorpg-test` repo →
   Build Command `npm install`, Start Command `npm start`. The service
   listens on `$PORT` automatically.
3. **Neon** — create a database in the same Neon project as the other
   games, copy its connection string, and set it as the Render env var
   `DATABASE_URL`. (Without it the service still runs, on the JSON
   fallback — but data would not survive a redeploy.)
4. **GM accounts** — set the Render env var `GM_ACCOUNTS` to a
   comma-separated list of account names (default is just `cody`).
5. Verify: open the Render URL, register, create a character, and have
   a second player join — you should see each other in Dawnhollow Vale.

## Files

- `public/index.html` — the whole game client (slice 1 game + slice 2
  multiplayer wiring: WebSocket client, other-player rendering, chat UI,
  shop/armory UI, GM target select).
- `server.js` — Express + WebSocket server: accounts, characters,
  server-owned enemies, guards, friendlies, world chat, shops, GM actions,
  autosave.
- `test/smoke.mjs` — two-client smoke test (see above).
