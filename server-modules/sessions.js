// Tiny signed-cookie session store.
// Cookie value = base64url(JSON({ uid, exp })) + "." + hmac-sha256(value, SESSION_SECRET).
// httpOnly + SameSite=Lax. 30-day rolling.

const crypto = require("crypto");

const COOKIE_NAME = "ptcg_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  return s;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function sign(payload) {
  const value = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret()).update(value).digest();
  return `${value}.${b64url(sig)}`;
}

function verify(cookie) {
  if (!cookie || typeof cookie !== "string") return null;
  const dot = cookie.lastIndexOf(".");
  if (dot < 0) return null;
  const value = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = b64url(crypto.createHmac("sha256", secret()).update(value).digest());
  if (
    expected.length !== sig.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(fromB64url(value).toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function setSession(res, uid) {
  const payload = { uid, exp: Date.now() + TTL_MS };
  const cookie = sign(payload);
  res.cookie(COOKIE_NAME, cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: TTL_MS,
    path: "/",
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

function getSession(req) {
  return verify(req.cookies?.[COOKIE_NAME]);
}

// Express middleware — attach req.user (or null) and refresh rolling cookie.
function attach(supabase) {
  return async function (req, res, next) {
    const s = getSession(req);
    if (!s?.uid) {
      req.user = null;
      return next();
    }
    const { data, error } = await supabase
      .from("users")
      .select("id, display_name, created_at, last_seen, trainer_ability")
      .eq("id", s.uid)
      .maybeSingle();
    if (error) {
      console.warn("[session] supabase lookup failed:", error.message);
      req.user = null;
      return next();
    }
    if (!data) {
      clearSession(res);
      req.user = null;
      return next();
    }
    req.user = data;
    // Touch last_seen but no need to await
    supabase
      .from("users")
      .update({ last_seen: new Date().toISOString() })
      .eq("id", data.id)
      .then(() => {}, () => {});
    // Rolling refresh
    setSession(res, data.id);
    next();
  };
}

module.exports = { setSession, clearSession, getSession, attach, COOKIE_NAME };
