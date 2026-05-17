// Hand-rolled WebAuthn ceremony — no @simplewebauthn/browser dep.
// The server sends options where buffer fields (challenge, user.id, allowed
// credential ids) are base64url-encoded strings. We decode them to ArrayBuffer
// before passing to navigator.credentials.* and re-encode the response.

function b64urlToBuf(s) {
  if (s instanceof ArrayBuffer) return s;
  if (typeof s !== "string") {
    throw new Error("passkey: expected base64url string, got " + typeof s);
  }
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  // Strip any whitespace + filter to the base64 alphabet so iOS Safari's
  // strict atob() doesn't throw "The string did not match the expected
  // pattern." on edge-case payloads.
  s = s.replace(/[^A-Za-z0-9+/=]/g, "");
  let bin;
  try {
    bin = atob(s);
  } catch (err) {
    throw new Error(`passkey: failed to decode base64url payload (${err?.name || "error"})`);
  }
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isSupported() {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

export async function isPlatformAvailable() {
  if (!isSupported()) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function decodeRegistrationOptions(opts) {
  return {
    ...opts,
    challenge: b64urlToBuf(opts.challenge),
    user: { ...opts.user, id: b64urlToBuf(opts.user.id) },
    excludeCredentials: (opts.excludeCredentials || []).map((c) => ({
      ...c,
      id: b64urlToBuf(c.id),
    })),
  };
}

function decodeAuthOptions(opts) {
  return {
    ...opts,
    challenge: b64urlToBuf(opts.challenge),
    allowCredentials: (opts.allowCredentials || []).map((c) => ({
      ...c,
      id: b64urlToBuf(c.id),
    })),
  };
}

function encodeRegistrationCredential(cred) {
  const r = cred.response;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      attestationObject: bufToB64url(r.attestationObject),
      transports: r.getTransports?.() || [],
      publicKeyAlgorithm: r.getPublicKeyAlgorithm?.(),
      publicKey: r.getPublicKey ? bufToB64url(r.getPublicKey()) : undefined,
      authenticatorData: r.getAuthenticatorData ? bufToB64url(r.getAuthenticatorData()) : undefined,
    },
  };
}

function encodeAuthCredential(cred) {
  const r = cred.response;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      authenticatorData: bufToB64url(r.authenticatorData),
      signature: bufToB64url(r.signature),
      userHandle: r.userHandle ? bufToB64url(r.userHandle) : null,
    },
  };
}

// --- High-level flow -------------------------------------------------------

export async function register(displayName) {
  if (!isSupported()) throw new Error("Passkeys are not supported in this browser.");

  const beg = await fetch("/auth/register/begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  const begData = await beg.json();
  if (!beg.ok) throw new Error(begData.error || "register/begin failed");

  const options = decodeRegistrationOptions(begData.options);
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: options });
  } catch (err) {
    throw new Error(err.message || "Passkey creation was cancelled.");
  }
  if (!credential) throw new Error("No credential created.");

  const fin = await fetch("/auth/register/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: begData.challengeId,
      credential: encodeRegistrationCredential(credential),
      deviceName: deviceLabel(),
    }),
  });
  const finData = await fin.json();
  if (!fin.ok) throw new Error(finData.error || "register/complete failed");
  // First account on this device gets any guest-accumulated state
  // (owned cards, story progress, champion wins) merged into the
  // freshly-created user. Failure is silent — the account is still
  // valid, the guest state just doesn't migrate.
  try {
    const guest = await import("./guest-state.js");
    await guest.migrateOnSignup();
  } catch {}
  return finData.user;
}

export async function login(displayName = "") {
  if (!isSupported()) throw new Error("Passkeys are not supported in this browser.");

  const beg = await fetch("/auth/login/begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  const begData = await beg.json();
  if (!beg.ok) throw new Error(begData.error || "login/begin failed");

  const options = decodeAuthOptions(begData.options);
  let credential;
  try {
    credential = await navigator.credentials.get({ publicKey: options });
  } catch (err) {
    throw new Error(err.message || "Passkey signing was cancelled.");
  }
  if (!credential) throw new Error("No credential returned.");

  const fin = await fetch("/auth/login/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: begData.challengeId,
      credential: encodeAuthCredential(credential),
    }),
  });
  const finData = await fin.json();
  if (!fin.ok) throw new Error(finData.error || "login/complete failed");
  // Signing in from a device that previously played as a guest: merge
  // any local state into the now-authenticated user. Idempotent +
  // capped server-side.
  try {
    const guest = await import("./guest-state.js");
    await guest.migrateOnSignup();
  } catch {}
  return finData.user;
}

export async function me() {
  const res = await fetch("/auth/me", { credentials: "same-origin" });
  if (!res.ok) return null;
  const { user } = await res.json();
  return user;
}

export async function logout() {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
}

function deviceLabel() {
  const ua = navigator.userAgent || "";
  if (/Mac/i.test(ua)) return "Mac";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  return "Device";
}
