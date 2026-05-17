// Site password gate. A soft gate over the landing page only —
// static assets + API endpoints stay reachable for the gate page
// itself to load and submit. Determined visitors can still hit
// /api/* directly, but the actual app UI requires the password.
//
// Password sources, in priority order:
//   1. process.env.SITE_PASSWORD
//   2. hardcoded fallback (set by the project owner)
//
// Cookie is signed with the same SESSION_SECRET as the auth session.

const crypto = require("crypto");

const COOKIE_NAME = "ptcg_gate";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function secret() {
  return process.env.SESSION_SECRET || "dev-fallback-secret-do-not-ship";
}
function sitePassword() {
  // Production reads from SITE_PASSWORD env var (set on Vercel).
  // The dev fallback below is intentionally generic — change locally
  // by exporting SITE_PASSWORD in your shell or .env file.
  return process.env.SITE_PASSWORD || "letmein";
}
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}
function signGate() {
  const payload = { gate: true, exp: Date.now() + TTL_MS };
  const value = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret()).update(value).digest();
  return `${value}.${b64url(sig)}`;
}
function verifyGate(cookie) {
  if (!cookie || typeof cookie !== "string") return false;
  const dot = cookie.lastIndexOf(".");
  if (dot < 0) return false;
  const value = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = b64url(crypto.createHmac("sha256", secret()).update(value).digest());
  if (expected.length !== sig.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  try {
    const payload = JSON.parse(fromB64url(value).toString("utf8"));
    return payload?.gate === true && payload.exp && Date.now() < payload.exp;
  } catch {
    return false;
  }
}

// The gate page itself — inlined HTML so it doesn't need any of the
// app's static assets to load.
function gatePage({ wrong = false, redirectTo = "/" } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pokémon TCG — Access</title>
  <style>
    *,*::before,*::after { box-sizing: border-box; }
    body {
      margin: 0; padding: 24px;
      min-height: 100vh;
      display: grid; place-items: center;
      background: radial-gradient(ellipse at center, #1a1538 0%, #06061a 65%, #000 100%);
      color: #e9ecff;
      font-family: -apple-system, system-ui, sans-serif;
    }
    .gate {
      background: linear-gradient(160deg, rgba(255,255,255,0.04), rgba(0,0,0,0.4));
      border: 1px solid rgba(255,209,102,0.45);
      border-radius: 16px;
      padding: 32px 30px;
      width: min(420px, 100%);
      text-align: center;
      box-shadow: 0 14px 50px rgba(0,0,0,0.6), 0 0 40px rgba(255,209,102,0.15);
    }
    h1 {
      margin: 0 0 6px;
      font-size: 22px;
      background: linear-gradient(120deg, #ffd166, #ef476f, #06d6a0);
      background-size: 200% 100%;
      -webkit-background-clip: text; background-clip: text;
      color: transparent;
      animation: shift 6s linear infinite;
    }
    @keyframes shift { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
    p { font-size: 13px; opacity: 0.7; margin: 0 0 22px; }
    .err {
      color: #ff8a8a;
      font-size: 12px;
      margin: 0 0 12px;
      padding: 8px 12px;
      background: rgba(239,71,111,0.1);
      border-radius: 6px;
      border: 1px solid rgba(239,71,111,0.3);
    }
    input[type=password] {
      width: 100%;
      padding: 12px 14px;
      font-size: 15px;
      background: rgba(0,0,0,0.5);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 10px;
      color: #fff;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    input[type=password]:focus {
      outline: none;
      border-color: #ffd166;
      box-shadow: 0 0 14px rgba(255,209,102,0.4);
    }
    button {
      width: 100%;
      margin-top: 12px;
      padding: 12px;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      background: linear-gradient(135deg, #ffd166, #ef476f);
      color: #1a0518;
      box-shadow: 0 4px 18px rgba(255,209,102,0.35);
    }
    button:hover { filter: brightness(1.1); }
    .hint { font-size: 10px; opacity: 0.45; margin-top: 18px; letter-spacing: 1px; text-transform: uppercase; }
  </style>
</head>
<body>
  <form class="gate" method="POST" action="/api/gate">
    <h1>Pokémon TCG</h1>
    <p>Private build — enter the password to continue.</p>
    ${wrong ? `<div class="err">Wrong password. Try again.</div>` : ""}
    <input type="hidden" name="redirect" value="${escapeHtml(redirectTo)}">
    <input type="password" name="password" autocomplete="current-password" autofocus required placeholder="Password">
    <button type="submit">Enter ▸</button>
    <div class="hint">private build · v1</div>
  </form>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
}

// Middleware that gates the landing page. Static assets + API routes
// stay open so the gate form itself can submit.
function gateMiddleware(req, res, next) {
  const path = req.path;
  // Gate ONLY the bare index. Everything else (api routes, static
  // files, auth flow) is unaffected.
  const isLanding = path === "/" || path === "/index.html";
  if (!isLanding) return next();
  if (verifyGate(req.cookies?.[COOKIE_NAME])) return next();
  res.set("content-type", "text/html; charset=utf-8");
  res.status(401).send(gatePage());
}

function mount(app) {
  // The gate submission. Accepts either JSON or form-encoded.
  app.post("/api/gate", (req, res) => {
    const supplied = String(
      req.body?.password ?? req.query?.password ?? ""
    );
    if (supplied !== sitePassword()) {
      // Form submit → re-render gate with error. JSON → JSON error.
      const wantsHtml = (req.get("accept") || "").includes("text/html");
      if (wantsHtml) {
        res.set("content-type", "text/html; charset=utf-8");
        return res.status(401).send(gatePage({ wrong: true, redirectTo: req.body?.redirect || "/" }));
      }
      return res.status(401).json({ error: "Wrong password." });
    }
    res.cookie(COOKIE_NAME, signGate(), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: TTL_MS,
      path: "/",
    });
    const wantsHtml = (req.get("accept") || "").includes("text/html");
    if (wantsHtml) {
      const to = req.body?.redirect || "/";
      return res.redirect(303, to.startsWith("/") ? to : "/");
    }
    res.json({ ok: true });
  });
}

// urlencoded parser needed for form submissions — small + scoped to
// the gate route so it doesn't slow other requests.
function parseFormBody(app) {
  const express = require("express");
  app.use("/api/gate", express.urlencoded({ extended: false, limit: "1kb" }));
}

module.exports = { gateMiddleware, mount, parseFormBody };
