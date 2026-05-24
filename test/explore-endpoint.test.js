// Tests for the public /api/pokedex/all endpoint that powers Explore.
// Boots a tiny Express app with the same route shape server.js uses,
// confirms the response is full-detail JSON and excludes spell cards.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("http");
const { toCard } = require("../shared/deck-builder");
const { allSpellCards } = require("../shared/spell-cards");

// Synth a small dex + the live spell catalog. /api/pokedex/all should
// only return the Pokémon (spell cards live in the same in-memory
// pokedex array on the server, but the Explore endpoint must filter
// them out — players don't browse spells via Pokédex).
function makePokedex() {
  const rows = [];
  for (let i = 1; i <= 8; i++) {
    const bst = 300 + i * 30;
    const per = Math.round(bst / 6);
    rows.push(toCard({
      id: i, name: `Mon${i}`, slug: `mon${i}`,
      types: i % 2 ? ["fire"] : ["water"],
      hp: per, attack: per, defense: per, sp_attack: per, sp_defense: per, speed: per,
      generation: 1,
      is_legendary: i === 8,
      is_mythical: false,
    }));
  }
  rows.push(...allSpellCards());
  return rows;
}

function bootRoute(pokedex) {
  // Mirror server.js: same filter + same response shape.
  const app = express();
  app.get("/api/pokedex/all", (_req, res) => {
    const rows = pokedex
      .filter((c) => c.kind !== "spell")
      .map((c) => ({
        id: c.id, name: c.name, slug: c.slug,
        sprite_front: c.sprite_front, sprite_back: c.sprite_back,
        types: c.types, generation: c.generation,
        bst: c.bst, tier: c.tier, rarity: c.rarity,
        energyCost: c.energyCost, cardHp: c.cardHp, cardAttack: c.cardAttack,
        is_legendary: !!c.is_legendary, is_mythical: !!c.is_mythical,
        flavor_text: c.flavor_text, abilities: c.abilities || [], raw: c.raw,
      }));
    res.set("Cache-Control", "public, max-age=600");
    res.json({ count: rows.length, rows });
  });
  return app;
}

async function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf), headers: res.headers }); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

test("/api/pokedex/all returns 200 with a count + rows array", async () => {
  const app = bootRoute(makePokedex());
  const server = await new Promise((r) => {
    const s = http.createServer(app).listen(0, "127.0.0.1", () => r(s));
  });
  try {
    const res = await get(server.address().port, "/api/pokedex/all");
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.count, "number");
    assert.ok(Array.isArray(res.json.rows));
    assert.equal(res.json.rows.length, res.json.count);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("/api/pokedex/all excludes spell cards (no kind:spell rows)", async () => {
  const app = bootRoute(makePokedex());
  const server = await new Promise((r) => {
    const s = http.createServer(app).listen(0, "127.0.0.1", () => r(s));
  });
  try {
    const res = await get(server.address().port, "/api/pokedex/all");
    for (const row of res.json.rows) {
      assert.ok(row.kind !== "spell", `spell card leaked into Explore response: ${row.name}`);
    }
    // Spell catalog has 18 active items as of slice 7; the response
    // should be the Pokémon count (8) — not 8+18.
    assert.equal(res.json.count, 8);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("/api/pokedex/all rows carry the detail fields Explore needs", async () => {
  const app = bootRoute(makePokedex());
  const server = await new Promise((r) => {
    const s = http.createServer(app).listen(0, "127.0.0.1", () => r(s));
  });
  try {
    const res = await get(server.address().port, "/api/pokedex/all");
    const sample = res.json.rows[0];
    // Required for the detail panel:
    for (const k of ["id", "name", "types", "tier", "rarity",
                     "energyCost", "cardHp", "cardAttack", "bst",
                     "raw", "is_legendary", "is_mythical"]) {
      assert.ok(k in sample, `row missing field "${k}"`);
    }
    // raw stats sub-object
    for (const k of ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"]) {
      assert.ok(k in sample.raw, `raw stats missing "${k}"`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("/api/pokedex/all sets a cache header so the dex doesn't re-fetch on every open", async () => {
  // The pokedex is static at runtime — let the client cache it.
  const app = bootRoute(makePokedex());
  const server = await new Promise((r) => {
    const s = http.createServer(app).listen(0, "127.0.0.1", () => r(s));
  });
  try {
    const res = await get(server.address().port, "/api/pokedex/all");
    const cache = res.headers["cache-control"] || "";
    assert.match(cache, /max-age=\d+/, "expected Cache-Control with max-age");
    assert.match(cache, /public/, "expected public cache");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
