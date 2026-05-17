// Theme week — server picks a Pokémon type as "type of the week" via the
// ISO week number, deterministically rotating through the 18 types. Cards
// of that type get a small attack bonus during matches, and reward rolls
// are biased toward that type (~30% extra chance per pick).

const TYPES_IN_ROTATION = [
  "fire", "water", "grass", "electric", "psychic", "ice",
  "fighting", "poison", "ground", "flying", "bug", "rock",
  "ghost", "dragon", "dark", "steel", "fairy", "normal",
];

function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday of current week determines the year.
  const dayNr = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = (d - firstThursday) / 86400000;
  return Math.ceil((diff + 1) / 7);
}

function currentTheme() {
  // Allow env override (THEME_TYPE=fire). Otherwise rotate by ISO week.
  const override = (process.env.THEME_TYPE || "").toLowerCase().trim();
  if (override && TYPES_IN_ROTATION.includes(override)) return override;
  const wk = isoWeek();
  return TYPES_IN_ROTATION[wk % TYPES_IN_ROTATION.length];
}

function weekEndsAt() {
  // Saturday UTC midnight of the current week.
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const daysUntilSun = (7 - day) % 7;  // 0 if Sun, 6 if Sat... wait
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + (7 - day));
  end.setUTCHours(0, 0, 0, 0);
  return end.toISOString();
}

function mount(app) {
  app.get("/api/theme", (_req, res) => {
    res.json({ type: currentTheme(), endsAt: weekEndsAt() });
  });
}

module.exports = { mount, currentTheme };
