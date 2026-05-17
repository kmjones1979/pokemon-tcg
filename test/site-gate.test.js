// Tests for the site-password gate: cookie sign/verify, middleware
// behavior (lands gate page when no cookie / passes through when
// valid / lets non-landing routes through unconditionally), and the
// /api/gate endpoint accepting the right password.

const { test } = require("node:test");
const assert = require("node:assert/strict");

// The gate module needs SESSION_SECRET; the existing test/sessions.js
// already sets one but in case this file runs first, set it here too.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-for-unit-tests";
process.env.SITE_PASSWORD = "test-password-123";

const siteGate = require("../server-modules/site-gate");

function mockReq({ path = "/", cookies = {}, body = {}, accept = "*/*" } = {}) {
  return {
    path,
    cookies,
    body,
    get: (h) => (h.toLowerCase() === "accept" ? accept : null),
    query: {},
  };
}

function mockRes() {
  const r = {
    statusCode: 200,
    headers: {},
    body: null,
    cookies: {},
    redirected: null,
  };
  r.status = (n) => { r.statusCode = n; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.json = (j) => { r.body = JSON.stringify(j); return r; };
  r.cookie = (name, value, opts) => { r.cookies[name] = { value, opts }; return r; };
  r.redirect = (code, url) => { r.statusCode = code; r.redirected = url; return r; };
  return r;
}

// ---- gateMiddleware -------------------------------------------------

test("gateMiddleware blocks GET / without cookie → 401 + gate HTML", () => {
  const req = mockReq({ path: "/" });
  const res = mockRes();
  let nextCalled = false;
  siteGate.gateMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.ok(res.body?.includes("<form"), "gate page should include a form");
  assert.ok(res.body?.includes("Enter"), "gate page should include the Enter CTA");
  assert.equal(nextCalled, false);
});

test("gateMiddleware blocks /index.html the same way", () => {
  const req = mockReq({ path: "/index.html" });
  const res = mockRes();
  let nextCalled = false;
  siteGate.gateMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("gateMiddleware lets non-landing routes through (API + static)", () => {
  for (const path of ["/api/deck", "/client/js/main.js", "/api/daily/today", "/_vercel/insights/script.js"]) {
    const req = mockReq({ path });
    const res = mockRes();
    let nextCalled = false;
    siteGate.gateMiddleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, `expected next() for ${path}`);
    assert.equal(res.statusCode, 200, `expected default 200 for ${path}`);
  }
});

// ---- /api/gate ------------------------------------------------------

function makeApp() {
  const handlers = {};
  return {
    handlers,
    post(path, fn) { handlers["POST " + path] = fn; },
    get(path, fn)  { handlers["GET "  + path] = fn; },
    use() {},
  };
}

test("mount() registers POST /api/gate", () => {
  const app = makeApp();
  siteGate.mount(app);
  assert.ok(app.handlers["POST /api/gate"], "POST /api/gate should be registered");
});

test("/api/gate rejects wrong password → 401", () => {
  const app = makeApp();
  siteGate.mount(app);
  const handler = app.handlers["POST /api/gate"];
  const req = mockReq({ path: "/api/gate", body: { password: "nope" }, accept: "application/json" });
  const res = mockRes();
  handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Wrong password/);
  assert.equal(res.cookies.ptcg_gate, undefined, "no cookie on rejection");
});

test("/api/gate accepts right password → 200 JSON + sets cookie", () => {
  const app = makeApp();
  siteGate.mount(app);
  const handler = app.handlers["POST /api/gate"];
  const req = mockReq({ path: "/api/gate", body: { password: "test-password-123" }, accept: "application/json" });
  const res = mockRes();
  handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /"ok":true/);
  assert.ok(res.cookies.ptcg_gate?.value, "should set ptcg_gate cookie");
  assert.ok(res.cookies.ptcg_gate.opts?.httpOnly, "cookie must be httpOnly");
  assert.equal(res.cookies.ptcg_gate.opts?.sameSite, "lax");
});

test("/api/gate with HTML accept → 303 redirect on success", () => {
  const app = makeApp();
  siteGate.mount(app);
  const handler = app.handlers["POST /api/gate"];
  const req = mockReq({
    path: "/api/gate",
    body: { password: "test-password-123", redirect: "/" },
    accept: "text/html,application/xhtml+xml",
  });
  const res = mockRes();
  handler(req, res);
  assert.equal(res.statusCode, 303);
  assert.equal(res.redirected, "/");
});

test("/api/gate with HTML accept + wrong password → re-renders gate with error", () => {
  const app = makeApp();
  siteGate.mount(app);
  const handler = app.handlers["POST /api/gate"];
  const req = mockReq({
    path: "/api/gate",
    body: { password: "nope" },
    accept: "text/html",
  });
  const res = mockRes();
  handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /Wrong password\. Try again/);
});

test("/api/gate prevents bypass via empty body", () => {
  const app = makeApp();
  siteGate.mount(app);
  const handler = app.handlers["POST /api/gate"];
  // Empty password should NOT match (the default fallback is "letmein"
  // for dev — but our test password is "test-password-123").
  const req = mockReq({ path: "/api/gate", accept: "application/json" });
  const res = mockRes();
  handler(req, res);
  assert.equal(res.statusCode, 401);
});

// ---- end-to-end: gate cookie issued in /api/gate is accepted by middleware ----

test("cookie issued by /api/gate is accepted by gateMiddleware", () => {
  // 1. Mint a cookie via the gate handler.
  const app = makeApp();
  siteGate.mount(app);
  const handler = app.handlers["POST /api/gate"];
  const req1 = mockReq({ path: "/api/gate", body: { password: "test-password-123" }, accept: "application/json" });
  const res1 = mockRes();
  handler(req1, res1);
  const cookie = res1.cookies.ptcg_gate.value;
  assert.ok(cookie, "should have minted a cookie");
  // 2. Use that cookie in a subsequent request — middleware passes through.
  const req2 = mockReq({ path: "/", cookies: { ptcg_gate: cookie } });
  const res2 = mockRes();
  let nextCalled = false;
  siteGate.gateMiddleware(req2, res2, () => { nextCalled = true; });
  assert.equal(nextCalled, true, "middleware should next() with a valid cookie");
  assert.equal(res2.statusCode, 200);
});

test("tampered cookie is rejected", () => {
  const app = makeApp();
  siteGate.mount(app);
  const handler = app.handlers["POST /api/gate"];
  const req1 = mockReq({ path: "/api/gate", body: { password: "test-password-123" }, accept: "application/json" });
  const res1 = mockRes();
  handler(req1, res1);
  const cookie = res1.cookies.ptcg_gate.value;
  // Mutate the payload — strips the trailing chars of the value.
  const dot = cookie.lastIndexOf(".");
  const tampered = cookie.slice(0, dot - 4) + "XXXX" + cookie.slice(dot);
  const req2 = mockReq({ path: "/", cookies: { ptcg_gate: tampered } });
  const res2 = mockRes();
  let nextCalled = false;
  siteGate.gateMiddleware(req2, res2, () => { nextCalled = true; });
  assert.equal(nextCalled, false, "middleware should NOT pass tampered cookie");
  assert.equal(res2.statusCode, 401);
});
