// Deck-share routes. Two surfaces:
//
//   GET /d/<code>            human-readable landing: show the deck +
//                            a CTA to either copy it into the user's
//                            collection or jump straight into a match.
//                            Hydrates the cards via the pokedex so
//                            the page is shareable on social as-is.
//   GET /api/deck-code/:code returns the hydrated cards for the
//                            deck-builder to load when the user opens
//                            ?d=<code> on the home page.
//
// Encoding lives in shared/deck-codes.js so this stays small.

const { decodeDeckCode } = require("../shared/deck-codes");
const { toCard } = require("../shared/deck-builder");

function mount(app, supabase, getPokedex) {
  async function loadDex() {
    const v = getPokedex();
    return v && typeof v.then === "function" ? await v : v;
  }

  async function hydrate(ids) {
    const dex = await loadDex();
    if (dex?.length) {
      const byId = new Map(dex.map((c) => [c.id, c]));
      return ids.map((id) => byId.get(id) || { id, name: `?#${id}`, missing: true });
    }
    if (!supabase) return ids.map((id) => ({ id, name: `?#${id}`, missing: true }));
    const unique = [...new Set(ids)];
    const { data: rows } = await supabase.from("pokemon").select("*").in("id", unique);
    const byId = new Map((rows || []).map((r) => [r.id, toCard(r)]));
    return ids.map((id) => byId.get(id) || { id, name: `?#${id}`, missing: true });
  }

  // JSON read for the deck-builder load flow.
  app.get("/api/deck-code/:code", async (req, res) => {
    try {
      const ids = decodeDeckCode(req.params.code);
      const cards = await hydrate(ids);
      res.json({ ids, cards });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Pretty landing page for shared URLs. SSR'd so the OG tags + body
  // preview render for crawlers (iMessage, Discord, Twitter cards).
  app.get("/d/:code", async (req, res) => {
    let ids, cards;
    try {
      ids = decodeDeckCode(req.params.code);
      cards = await hydrate(ids);
    } catch (err) {
      res.status(404);
      return res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;color:#fff;background:#0c0d1a;padding:40px;text-align:center"><h1>Deck not found</h1><p>${escape(err.message)}</p><a href="/" style="color:#ffd166">← Back to the game</a></body></html>`);
    }
    // Count by tier for the preview banner.
    const byTier = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const c of cards) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
    const typeCounts = {};
    for (const c of cards) {
      for (const t of (c.types || [])) typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    const topTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const featured = cards
      .filter((c) => c.is_legendary || c.is_mythical || c.tier >= 4)
      .slice(0, 8);
    const featuredFallback = cards.slice(0, 8);
    const previewCards = featured.length ? featured : featuredFallback;
    const code = req.params.code;
    const origin = (req.headers["x-forwarded-host"] && `https://${req.headers["x-forwarded-host"]}`)
                || (req.headers.host && `https://${req.headers.host}`) || "";

    res.set("content-type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Shared deck · Pokémon TCG</title>
  <meta name="description" content="${escape("A 30-card Pokémon TCG deck with " + topTypes.map(([t, n]) => `${n} ${t}`).join(", ") + ".")}" />
  <meta property="og:title" content="${escape(`Deck: ${topTypes.map(([t]) => t).join("/") || "Pokémon TCG"}`)}" />
  <meta property="og:description" content="${escape(`A 30-card build featuring ${previewCards.map((c) => c.name).slice(0, 4).join(", ")}…`)}" />
  <meta property="og:image" content="${origin}/og-card.png" />
  <meta property="og:url" content="${origin}/d/${escape(code)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: radial-gradient(ellipse at center, #1a1538 0%, #06061a 65%, #000 100%); color: #e9ecff; margin: 0; padding: 24px; min-height: 100vh; }
    .wrap { max-width: 880px; margin: 0 auto; }
    h1 { background: linear-gradient(135deg,#ffd166,#ef476f); -webkit-background-clip:text; background-clip:text; color:transparent; font-size: clamp(24px, 4vw, 36px); margin: 0 0 6px; }
    .sub { opacity: 0.75; font-size: 14px; margin: 0 0 22px; }
    .meta { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; margin: 0 0 18px; }
    .meta span { padding: 6px 12px; background: rgba(255,255,255,0.06); border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); }
    .featured { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; margin-bottom: 26px; }
    .feat { background: linear-gradient(160deg, rgba(255,255,255,0.05), rgba(0,0,0,0.45)); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 10px; text-align: center; }
    .feat img { width: 80px; height: 80px; object-fit: contain; image-rendering: pixelated; }
    .feat .name { font-size: 12px; font-weight: 600; margin-top: 4px; }
    .feat .tag { font-size: 10px; opacity: 0.7; }
    .cta { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0; }
    .cta a { padding: 12px 20px; border-radius: 10px; font-weight: 700; text-decoration: none; }
    .cta .primary { background: linear-gradient(135deg, #ffd166, #ef476f); color: #1a0518; box-shadow: 0 4px 18px rgba(255,209,102,0.35); }
    .cta .ghost { background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.18); }
    .list { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 6px; font-size: 11px; }
    .list .row { padding: 6px 8px; background: rgba(255,255,255,0.04); border-radius: 6px; opacity: 0.85; }
    code { background: rgba(0,0,0,0.5); padding: 4px 8px; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 11px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Shared deck</h1>
    <p class="sub">A 30-card Pokémon TCG build. Load it into your collection or battle against it.</p>
    <div class="meta">
      ${topTypes.map(([t, n]) => `<span>${escape(t)} ×${n}</span>`).join("")}
      ${[1,2,3,4,5].map((t) => byTier[t] ? `<span>T${t}: ${byTier[t]}</span>` : "").join("")}
    </div>
    <div class="featured">
      ${previewCards.map((c) => `
        <div class="feat">
          ${c.sprite_front ? `<img src="${escape(c.sprite_front)}" loading="lazy" alt="">` : ""}
          <div class="name">${escape(c.name || "?")}</div>
          <div class="tag">${c.is_mythical ? "✦ MYTHICAL" : c.is_legendary ? "★ LEGENDARY" : `T${c.tier || "?"}`}</div>
        </div>`).join("")}
    </div>
    <div class="cta">
      <a class="primary" href="/?d=${escape(code)}">Open in deck builder ▸</a>
      <a class="ghost"   href="/?v=${escape(code)}">Battle this deck</a>
    </div>
    <details>
      <summary style="cursor:pointer;font-size:13px;opacity:0.7;margin:14px 0">All 30 cards</summary>
      <div class="list">
        ${cards.map((c, i) => `<div class="row">${i + 1}. ${escape(c.name || "?#" + c.id)}</div>`).join("")}
      </div>
    </details>
    <p style="margin-top:30px;font-size:11px;opacity:0.5;">Code: <code>${escape(code)}</code></p>
  </div>
</body>
</html>`);
  });
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
}

module.exports = { mount };
