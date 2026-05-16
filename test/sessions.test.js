// Tests for the signed-cookie session store. Doesn't require Supabase.

const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.SESSION_SECRET = "test-secret-do-not-use-in-prod";

const sessions = require("../server-modules/sessions");

function mockRes() {
  const cookies = {};
  return {
    cookies,
    cookie(name, val, opts) { cookies[name] = { val, opts }; },
    clearCookie(name) { delete cookies[name]; },
  };
}

test("setSession + getSession roundtrip", () => {
  const res = mockRes();
  sessions.setSession(res, "user-123");
  const req = { cookies: { [sessions.COOKIE_NAME]: res.cookies[sessions.COOKIE_NAME].val } };
  const s = sessions.getSession(req);
  assert.equal(s.uid, "user-123");
  assert.ok(s.exp > Date.now(), "exp is in the future");
});

test("tampered cookie is rejected", () => {
  const res = mockRes();
  sessions.setSession(res, "user-123");
  const original = res.cookies[sessions.COOKIE_NAME].val;
  // Flip a byte in the payload portion (before the dot).
  const dot = original.lastIndexOf(".");
  const tampered = "X" + original.slice(1, dot) + original.slice(dot);
  const s = sessions.getSession({ cookies: { [sessions.COOKIE_NAME]: tampered } });
  assert.equal(s, null);
});

test("missing cookie returns null", () => {
  assert.equal(sessions.getSession({ cookies: {} }), null);
  assert.equal(sessions.getSession({}), null);
});

test("clearSession removes the cookie", () => {
  const res = mockRes();
  sessions.setSession(res, "u1");
  sessions.clearSession(res);
  assert.equal(res.cookies[sessions.COOKIE_NAME], undefined);
});

test("expired session returns null", () => {
  const res = mockRes();
  sessions.setSession(res, "u1");
  // forge expired cookie
  const crypto = require("crypto");
  const b64url = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payload = b64url(JSON.stringify({ uid: "u1", exp: Date.now() - 1000 }));
  const sig = b64url(crypto.createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest());
  const expired = `${payload}.${sig}`;
  assert.equal(sessions.getSession({ cookies: { [sessions.COOKIE_NAME]: expired } }), null);
});
