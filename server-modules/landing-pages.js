// Per-Pokémon landing pages — server-rendered HTML at /p/:id with rich
// Open Graph + Twitter Card metadata so links shared to X, iMessage,
// Slack, WhatsApp, etc. show a proper preview (big artwork, name, type,
// description) instead of a bare URL.
//
// The page itself is also a nice standalone view: type-tinted card with
// the official artwork, name, types, card stats, base stats, flavor
// text, and a "Play with this Pokémon" CTA back to the game.
//
// :id accepts a numeric Pokédex id ("/p/25") or a name slug ("/p/pikachu").
//
// og:image points to the high-res official artwork on the PokéAPI sprite
// CDN (~475×475). Twitter accepts and crops; iMessage/Slack/Discord render
// the square as-is.

const TYPE_COLORS = {
  normal: "#a8a878", fire: "#f08030", water: "#6890f0", electric: "#f8d030",
  grass: "#78c850", ice: "#98d8d8", fighting: "#c03028", poison: "#a040a0",
  ground: "#e0c068", flying: "#a890f0", psychic: "#f85888", bug: "#a8b820",
  rock: "#b8a038", ghost: "#705898", dragon: "#7038f8", dark: "#705848",
  steel: "#b8b8d0", fairy: "#f0b6bc",
};

function originFor(req) {
  // Prefer the public site, but support previews + local dev. The OG image
  // is an absolute external URL so this only matters for og:url + canonical.
  const protoHeader = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function officialArtwork(id) {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function capitalize(s) {
  return String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildDescription(row) {
  const typesStr = (row.types || []).map(capitalize).join(" / ");
  const flag = row.is_legendary ? "Legendary" : row.is_mythical ? "Mythical" : "";
  const stats = `HP ${row.cardHp ?? "?"} · ATK ${row.cardAttack ?? "?"} · ⚡${row.energyCost ?? "?"}`;
  const flavor = String(row.flavor_text || "").replace(/[\f\n\r\t]+/g, " ").trim();
  const head = [typesStr, flag, `Gen ${row.generation ?? "?"}`].filter(Boolean).join(" · ");
  const desc = `${head}. ${stats}. ${flavor}`.replace(/\s+/g, " ").trim();
  return desc.length > 200 ? desc.slice(0, 197) + "…" : desc;
}

function renderLandingHtml(row, req) {
  const origin = originFor(req);
  const name = capitalize(row.name || "Unknown");
  const id3 = String(row.id).padStart(3, "0");
  const url = `${origin}/p/${row.id}`;
  const artwork = officialArtwork(row.id);
  const description = buildDescription(row);
  const primary = row.types?.[0] || "normal";
  const primaryColor = TYPE_COLORS[primary] || "#888";
  const flag = row.is_legendary ? { text: "★ LEGENDARY ★", color: "#f59e0b" }
              : row.is_mythical  ? { text: "✦ MYTHICAL ✦",  color: "#c084fc" }
              : null;
  const tierLabel = row.tier ? `Tier ${row.tier}` : "";
  const rarityLabel = (row.rarity || "common").replace(/^./, (c) => c.toUpperCase());

  const typePills = (row.types || [])
    .map((t) => `<span class="type-pill" style="background:${TYPE_COLORS[t] || "#888"}">${escapeHtml(capitalize(t))}</span>`)
    .join("");

  const raw = row.raw || {};
  const statRow = (label, val) => {
    const pct = Math.min(100, Math.round(((val || 0) / 200) * 100));
    return `
      <div class="stat">
        <span class="stat-label">${escapeHtml(label)}</span>
        <span class="stat-val">${val ?? 0}</span>
        <div class="stat-bar"><div class="stat-fill" style="width:${pct}%"></div></div>
      </div>`;
  };

  // OG / Twitter meta. og:image is an absolute external URL pointing to
  // the official artwork — Twitter and iMessage prefetch + cache this when
  // the link is shared, so it stays fast.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(name)} #${id3} — Pokémon Battle</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="${primaryColor}">
  <link rel="canonical" href="${escapeHtml(url)}">

  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Pokémon Battle">
  <meta property="og:title" content="${escapeHtml(name)} #${id3} — Pokémon Battle">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${escapeHtml(artwork)}">
  <meta property="og:image:secure_url" content="${escapeHtml(artwork)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="475">
  <meta property="og:image:height" content="475">
  <meta property="og:image:alt" content="${escapeHtml(name)}">
  <meta property="og:url" content="${escapeHtml(url)}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(name)} #${id3} — Pokémon Battle">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(artwork)}">
  <meta name="twitter:image:alt" content="${escapeHtml(name)}">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap">

  <style>
    :root { --type: ${primaryColor}; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: "Inter", system-ui, sans-serif;
      background:
        radial-gradient(ellipse at 50% 0%, var(--type) 0%, transparent 50%),
        linear-gradient(180deg, #1e1b4b 0%, #0f172a 100%);
      min-height: 100vh;
      color: #f1f5f9;
      padding: 16px;
      display: flex;
      align-items: flex-start;
      justify-content: center;
    }
    .nav {
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 10;
    }
    .back-link {
      color: rgba(255, 255, 255, 0.85);
      text-decoration: none;
      font-weight: 700;
      font-size: 13px;
      background: rgba(0, 0, 0, 0.35);
      padding: 8px 14px;
      border-radius: 999px;
      backdrop-filter: blur(8px);
    }
    .back-link:hover { background: rgba(0, 0, 0, 0.5); }

    .card {
      width: 100%;
      max-width: 460px;
      margin-top: 60px;
      margin-bottom: 24px;
      background: linear-gradient(160deg, #ffffff, #f5f3ff 85%, #ddd6fe);
      border-radius: 24px;
      box-shadow:
        0 30px 60px rgba(0, 0, 0, 0.4),
        0 0 0 4px rgba(0, 0, 0, 0.12),
        0 0 0 6px var(--type),
        0 0 80px rgba(99, 102, 241, 0.3);
      padding: 24px 22px 22px;
      color: #1e1b4b;
      animation: cardIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    @keyframes cardIn {
      from { transform: scale(0.92) translateY(20px); opacity: 0; }
      to   { transform: scale(1) translateY(0); opacity: 1; }
    }
    ${flag ? `
    .flag {
      display: inline-block;
      background: linear-gradient(135deg, ${flag.color}, #fde047);
      color: #1f2937;
      font-weight: 900;
      font-size: 11px;
      letter-spacing: 2px;
      padding: 4px 14px;
      border-radius: 999px;
      margin-bottom: 8px;
      box-shadow: 0 3px 8px rgba(245, 158, 11, 0.5);
    }` : ""}
    .art {
      width: 100%;
      height: 260px;
      background:
        radial-gradient(circle at center, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0)),
        radial-gradient(circle at center, var(--type) 0%, transparent 70%);
      border-radius: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 12px;
    }
    .art img {
      max-width: 230px;
      max-height: 230px;
      width: auto;
      height: auto;
      filter: drop-shadow(0 8px 14px rgba(0, 0, 0, 0.4));
    }
    .id-row {
      font-family: "Courier New", monospace;
      font-size: 11px;
      color: #6b7280;
      letter-spacing: 1.5px;
      text-align: center;
    }
    .name {
      font-size: 36px;
      font-weight: 900;
      margin: 4px 0 8px;
      text-align: center;
      letter-spacing: -0.5px;
      text-transform: capitalize;
    }
    .types {
      display: flex;
      gap: 8px;
      justify-content: center;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .type-pill {
      color: white;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      padding: 4px 12px;
      border-radius: 999px;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
    }
    .meta {
      display: flex;
      gap: 12px;
      justify-content: center;
      font-size: 12px;
      color: #6b7280;
      font-weight: 600;
      margin-bottom: 14px;
    }
    .quickstats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 18px;
    }
    .quickstats > div {
      background: rgba(99, 102, 241, 0.1);
      border-radius: 12px;
      padding: 10px 4px;
      text-align: center;
    }
    .quickstats strong {
      display: block;
      font-size: 26px;
      font-weight: 800;
      color: #1e1b4b;
    }
    .quickstats span {
      font-size: 10px;
      color: #6b7280;
      letter-spacing: 1px;
      font-weight: 700;
    }
    .section-heading {
      font-size: 11px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #6b7280;
      font-weight: 800;
      margin: 16px 0 8px;
    }
    .stat {
      display: grid;
      grid-template-columns: 48px 32px 1fr;
      align-items: center;
      gap: 8px;
      margin-bottom: 5px;
      font-size: 12px;
    }
    .stat-label { color: #6b7280; font-weight: 700; }
    .stat-val   { color: #1f2937; font-weight: 800; text-align: right; }
    .stat-bar   { background: #e5e7eb; border-radius: 999px; height: 7px; overflow: hidden; }
    .stat-fill  { background: linear-gradient(90deg, var(--type), #818cf8); height: 100%; border-radius: 999px; }

    .flavor {
      font-size: 13px;
      color: #4b5563;
      font-style: italic;
      line-height: 1.5;
      text-align: center;
      margin-top: 14px;
    }

    .actions {
      display: flex;
      gap: 10px;
      margin-top: 22px;
      flex-wrap: wrap;
      justify-content: center;
    }
    .play-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: linear-gradient(135deg, var(--type), #4338ca);
      color: white;
      text-decoration: none;
      font-weight: 800;
      font-size: 14px;
      padding: 12px 22px;
      border-radius: 12px;
      box-shadow: 0 3px 0 rgba(0, 0, 0, 0.25);
      transition: transform 0.12s ease;
    }
    .play-btn:hover { transform: translateY(-1px); }
    .share-btn {
      background: white;
      color: #1e1b4b;
      border: 2px solid #cbd5e1;
      font-weight: 800;
      font-size: 14px;
      padding: 12px 22px;
      border-radius: 12px;
      cursor: pointer;
      font-family: inherit;
      box-shadow: 0 3px 0 #cbd5e1;
    }
    .share-btn:hover { transform: translateY(-1px); }

    .footer-credit {
      text-align: center;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.45);
      margin-top: 16px;
    }
    .footer-credit a { color: rgba(255, 255, 255, 0.7); text-decoration: none; }
  </style>
</head>
<body>
  <div class="nav">
    <a class="back-link" href="/">← Pokémon Battle</a>
  </div>

  <main class="card">
    ${flag ? `<div style="text-align:center"><span class="flag">${escapeHtml(flag.text)}</span></div>` : ""}
    <div class="art">
      <img src="${escapeHtml(artwork)}" alt="${escapeHtml(name)} official artwork" loading="eager">
    </div>
    <div class="id-row">#${id3}</div>
    <h1 class="name">${escapeHtml(name)}</h1>
    <div class="types">${typePills}</div>
    <div class="meta">
      <span>Gen ${row.generation ?? "?"}</span>
      ${tierLabel ? `<span>${escapeHtml(tierLabel)} (${escapeHtml(rarityLabel)})</span>` : ""}
    </div>

    <div class="quickstats">
      <div><strong>${row.cardHp ?? "?"}</strong><span>HP</span></div>
      <div><strong>${row.cardAttack ?? "?"}</strong><span>ATK</span></div>
      <div><strong>${row.energyCost ?? "?"}</strong><span>⚡ ENERGY</span></div>
    </div>

    <div class="section-heading">Base Stats${row.bst ? ` · BST ${row.bst}` : ""}</div>
    ${statRow("HP",  raw.hp)}
    ${statRow("ATK", raw.attack)}
    ${statRow("DEF", raw.defense)}
    ${statRow("SpA", raw.sp_attack)}
    ${statRow("SpD", raw.sp_defense)}
    ${statRow("SPD", raw.speed)}

    ${row.flavor_text ? `<p class="flavor">${escapeHtml(row.flavor_text)}</p>` : ""}

    <div class="actions">
      <a class="play-btn" href="/">🎮 Play Pokémon Battle</a>
      <button class="share-btn" id="share-btn">↗ Share</button>
    </div>
  </main>

  <script>
    const shareData = {
      title: ${JSON.stringify(`${name} #${id3} — Pokémon Battle`)},
      text:  ${JSON.stringify(`Check out ${name} on Pokémon Battle!`)},
      url:   ${JSON.stringify(url)}
    };
    document.getElementById("share-btn").addEventListener("click", async () => {
      try {
        if (navigator.share) {
          await navigator.share(shareData);
        } else {
          await navigator.clipboard.writeText(shareData.url);
          const b = document.getElementById("share-btn");
          const t = b.textContent;
          b.textContent = "✓ Link copied!";
          setTimeout(() => { b.textContent = t; }, 1400);
        }
      } catch (err) {
        if (err.name !== "AbortError") console.warn(err);
      }
    });
  </script>

  <div class="footer-credit">
    Created by Red Botster at <a href="https://scallywaglabs.xyz/" target="_blank" rel="noopener">scallywaglabs.xyz</a>
  </div>
</body>
</html>`;
}

function notFoundHtml() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not Found · Pokémon Battle</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center;}a{color:#818cf8;}</style></head><body><h1 style="font-size:48px;margin:0">404</h1><p>That Pokémon doesn't exist.</p><p><a href="/">← Back to Pokémon Battle</a></p></body></html>`;
}

function mount(app, getPokedex) {
  // Express 4 (this project's express) treats `:id.png` as part of the
  // param, but other paths like /p/25 work as expected. Accept both
  // numeric ids and lowercase name slugs.
  app.get("/p/:id", async (req, res) => {
    let dex;
    try {
      dex = await getPokedex();
    } catch (err) {
      res.status(503).type("html").send(`<p>Pokédex loading… try again in a moment.</p>`);
      return;
    }
    if (!Array.isArray(dex) || !dex.length) {
      res.status(503).type("html").send(`<p>Pokédex loading… try again in a moment.</p>`);
      return;
    }
    const raw = String(req.params.id || "").trim().toLowerCase();
    let row;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      row = dex.find((r) => r.id === n);
    } else {
      row = dex.find((r) => (r.name || "").toLowerCase() === raw || (r.slug || "").toLowerCase() === raw);
    }
    if (!row) {
      res.status(404).type("html").send(notFoundHtml());
      return;
    }
    res.set("Cache-Control", "public, max-age=600");
    res.type("html").send(renderLandingHtml(row, req));
  });
}

module.exports = { mount, renderLandingHtml, buildDescription };
