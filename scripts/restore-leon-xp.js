// One-shot trainer-XP restoration for the avatar-feature wipe bug
// (2026-06-21). The xp.js SELECT included `unlocked_avatars` before
// the corresponding migration had been applied, which caused
// `before = 0` on a failed read and any /me/xp/grant call to write
// `trainer_xp = gained` instead of `trainer_xp = previous + gained`.
//
// Only Leon-ug0 played during the broken window; everyone else's
// trainer_xp was confirmed unchanged before this script ran.
//
// Safe to re-run: skips the update if trainer_xp >= TARGET_XP.

const { createClient } = require("@supabase/supabase-js");

const TARGET_ID  = "b5134fec-82b8-49c2-b47e-7a3e4316e88a";   // Leon-ug0
const TARGET_XP  = 59970;                                     // pre-bug snapshot
const REASON     = "avatar feature xp-wipe restoration 2026-06-21";

(async () => {
  const url = `https://${process.env.SUPABASE_PROJECT_ID}.supabase.co`;
  const sb  = createClient(url, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: before, error: readErr } = await sb
    .from("users")
    .select("id, display_name, trainer_xp")
    .eq("id", TARGET_ID)
    .maybeSingle();
  if (readErr || !before) {
    console.error("read failed:", readErr);
    process.exit(1);
  }
  console.log("before:", before);

  if ((before.trainer_xp || 0) >= TARGET_XP) {
    console.log("already at/above target; no change.");
    return;
  }

  const { error: writeErr } = await sb
    .from("users")
    .update({ trainer_xp: TARGET_XP })
    .eq("id", TARGET_ID);
  if (writeErr) {
    console.error("write failed:", writeErr);
    process.exit(1);
  }

  const { data: after } = await sb
    .from("users")
    .select("id, display_name, trainer_xp")
    .eq("id", TARGET_ID)
    .maybeSingle();
  console.log("after :", after);
  console.log("reason:", REASON);
})();
