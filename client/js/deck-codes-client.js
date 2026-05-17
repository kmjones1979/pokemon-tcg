// Thin ESM re-export of shared/deck-codes.js (which is CommonJS so
// it can be required by the server). Same encoder runs on both sides.
//
// We don't try to share the file directly because the server uses
// require() and the client uses ESM imports — bridging them with a
// build flag is more trouble than this 30-line shim.

const VERSION = 1;
const DECK_SIZE = 30;
const BITS_PER_ID = 12;
const MAX_ID = (1 << BITS_PER_ID) - 1;

export function encodeDeckIds(ids) {
  if (!Array.isArray(ids)) throw new Error("ids must be an array");
  if (ids.length !== DECK_SIZE) throw new Error(`expected ${DECK_SIZE} ids, got ${ids.length}`);
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 1 || id > MAX_ID) {
      throw new Error(`invalid id ${id}`);
    }
  }
  const buf = new Uint8Array(1 + 45);
  buf[0] = VERSION;
  let bitOffset = 8;
  for (const id of ids) {
    const byteIdx = bitOffset >> 3;
    const bitInByte = bitOffset & 7;
    const shifted = id << (24 - BITS_PER_ID - bitInByte);
    buf[byteIdx] |= (shifted >> 16) & 0xff;
    buf[byteIdx + 1] |= (shifted >> 8) & 0xff;
    if ((bitInByte + BITS_PER_ID) > 16) {
      buf[byteIdx + 2] |= shifted & 0xff;
    }
    bitOffset += BITS_PER_ID;
  }
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeDeckCode(code) {
  if (typeof code !== "string" || !code) throw new Error("code must be non-empty");
  let s = code.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  // iOS Safari's atob() is strict; sanitize to the base64 alphabet so
  // a stray character doesn't surface as "The string did not match
  // the expected pattern."
  s = s.replace(/[^A-Za-z0-9+/=]/g, "");
  let bin;
  try { bin = atob(s); }
  catch (err) { throw new Error(`deck-code decode failed (${err?.name || "atob error"})`); }
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  if (buf.length < 1 + 45) throw new Error("code truncated");
  if (buf[0] !== VERSION) throw new Error(`unsupported version ${buf[0]}`);
  const ids = [];
  let bitOffset = 8;
  for (let i = 0; i < DECK_SIZE; i++) {
    const byteIdx = bitOffset >> 3;
    const bitInByte = bitOffset & 7;
    let value =
      ((buf[byteIdx] << 16) | (buf[byteIdx + 1] << 8) | (buf[byteIdx + 2] || 0));
    value = (value >> (24 - BITS_PER_ID - bitInByte)) & MAX_ID;
    ids.push(value);
    bitOffset += BITS_PER_ID;
  }
  return ids;
}
