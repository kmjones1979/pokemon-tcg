// Shareable deck codes. A 30-card deck is just 30 pokemon ids (1..1025),
// so we pack each id as a fixed 12-bit value (4096 > 1025), giving:
//   30 ids × 12 bits = 360 bits = 45 bytes
// Encoded as base64url that's ~60 characters — short enough to live
// in a URL: pokemonbattle.xyz/d/<code>
//
// Format:
//   byte 0       : version (currently 1)
//   bytes 1..45  : packed 12-bit ids, big-endian, padded to a byte
//
// Order is preserved (the deck is a list, not a set) so two players
// can both decode to the same card sequence.

const VERSION = 1;
const DECK_SIZE = 30;
const BITS_PER_ID = 12;
const MAX_ID = (1 << BITS_PER_ID) - 1; // 4095

function encodeDeckIds(ids) {
  if (!Array.isArray(ids)) throw new Error("ids must be an array");
  if (ids.length !== DECK_SIZE) throw new Error(`expected ${DECK_SIZE} ids, got ${ids.length}`);
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 1 || id > MAX_ID) {
      throw new Error(`invalid id ${id} (must be integer 1..${MAX_ID})`);
    }
  }
  // 30 × 12 = 360 bits ⇒ 45 bytes. Plus 1 byte for version.
  const buf = new Uint8Array(1 + 45);
  buf[0] = VERSION;
  let bitOffset = 8; // byte 0 reserved for version
  for (const id of ids) {
    const byteIdx = bitOffset >> 3;
    const bitInByte = bitOffset & 7;
    // Write 12 bits MSB-first across up to two bytes (since 12 + up to
    // 7 leading bits fits within 3 bytes — but in practice 2 + maybe 1).
    const shifted = id << (24 - BITS_PER_ID - bitInByte);
    buf[byteIdx] |= (shifted >> 16) & 0xff;
    buf[byteIdx + 1] |= (shifted >> 8) & 0xff;
    if ((bitInByte + BITS_PER_ID) > 16) {
      buf[byteIdx + 2] |= shifted & 0xff;
    }
    bitOffset += BITS_PER_ID;
  }
  return base64urlEncode(buf);
}

function decodeDeckCode(code) {
  if (typeof code !== "string" || !code) throw new Error("code must be a non-empty string");
  const buf = base64urlDecode(code);
  if (buf.length < 1) throw new Error("code too short");
  const version = buf[0];
  if (version !== VERSION) throw new Error(`unsupported deck-code version ${version}`);
  if (buf.length < 1 + 45) throw new Error("code truncated");
  const ids = [];
  let bitOffset = 8;
  for (let i = 0; i < DECK_SIZE; i++) {
    const byteIdx = bitOffset >> 3;
    const bitInByte = bitOffset & 7;
    let value =
      ((buf[byteIdx] << 16) | (buf[byteIdx + 1] << 8) | (buf[byteIdx + 2] || 0));
    value = (value >> (24 - BITS_PER_ID - bitInByte)) & MAX_ID;
    if (value < 1) throw new Error(`decoded id #${i + 1} is invalid`);
    ids.push(value);
    bitOffset += BITS_PER_ID;
  }
  return ids;
}

// --- base64url helpers (no padding) ---------------------------------

function base64urlEncode(uint8) {
  // Work in Node + browser.
  let b64;
  if (typeof Buffer !== "undefined") {
    b64 = Buffer.from(uint8).toString("base64");
  } else {
    let bin = "";
    for (let i = 0; i < uint8.length; i++) bin += String.fromCharCode(uint8[i]);
    b64 = btoa(bin);
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(s, "base64"));
  }
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

module.exports = {
  encodeDeckIds,
  decodeDeckCode,
  DECK_SIZE,
  MAX_ID,
  VERSION,
};
