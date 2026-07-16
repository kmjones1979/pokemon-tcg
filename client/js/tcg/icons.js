// Inline SVG iconography for the TCG mode — energy symbols, Pokéball, Trainer
// and pile icons. Replaces the old emoji glyphs so the cards read like real
// Trading Card Game cards. Every export returns an SVG/HTML string.

export const TCG_COLORS = {
  fire: "#f0662e", water: "#3aa0e6", grass: "#5bbf5b", lightning: "#f2c216",
  psychic: "#b45fd6", fighting: "#c86a3a", colorless: "#c9c6bb",
};

// White glyph inner-content per energy type, drawn on a 24×24 viewBox. Placed
// on a type-colored circular badge (see .tcg-pip in tcg.css).
const ENERGY = {
  fire:
    '<path d="M12 2c2 3.5 4.6 5.4 4.6 9.3A4.6 4.6 0 0 1 7.4 12c0-2.2 1.3-3.4 2-4.8.6 1.7 2 2 2 2C10.6 6.8 10.9 4.6 12 2z"/>',
  water:
    '<path d="M12 3c0 0-6 7.6-6 11.4A6 6 0 0 0 18 14.4C18 10.6 12 3 12 3z"/>',
  grass:
    '<path d="M5 19C5 10.5 11 5 19 5c0 8.5-6 14-14 14z"/><path d="M8.6 15.4 15.4 8.6" stroke="rgba(0,0,0,.28)" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  lightning:
    '<path d="M13.5 2 6 13h4l-1.2 9L18 10h-4.3L15 2z"/>',
  psychic:
    '<path d="M2.5 12C5.4 7.7 18.6 7.7 21.5 12 18.6 16.3 5.4 16.3 2.5 12z"/><circle cx="12" cy="12" r="3.1" fill="rgba(0,0,0,.32)"/>',
  fighting:
    '<path d="M7.4 12v3.1a2 2 0 0 0 2 2h5.3a2 2 0 0 0 2-2v-3.4a1 1 0 0 0-2 0v.4h-.5v-2.1a1 1 0 0 0-2 0v2h-.5V9a1 1 0 0 0-2 0v3h-.5v-1.6a1 1 0 0 0-1.8 0V12z"/><path d="M7.4 11.6H6.5a1.2 1.2 0 0 0 0 2.4h.9z"/>',
  colorless:
    '<path d="M12 2.6l2.7 5.9 6.4.7-4.8 4.4 1.3 6.4L12 16.9 6.4 20l1.3-6.4L2.9 9.2l6.4-.7z"/>',
};

export function energySVG(type) {
  return `<svg viewBox="0 0 24 24" class="tcg-esvg" aria-hidden="true">${ENERGY[type] || ENERGY.colorless}</svg>`;
}

// A ready-made energy badge (colored circle + white glyph). `cls` lets callers
// add sizing/context classes.
export function energyBadge(type, cls = "") {
  const color = TCG_COLORS[type] || "#888";
  return `<span class="tcg-pip ${cls}" style="--type:${color}" title="${type}">${energySVG(type)}</span>`;
}

// Classic Pokéball — used for the card back and Prize markers.
export function pokeballSVG(cls = "") {
  return `<svg viewBox="0 0 100 100" class="tcg-ball ${cls}" aria-hidden="true">
    <circle cx="50" cy="50" r="46" fill="#f5f5f5" stroke="#1b1b1b" stroke-width="5"/>
    <path d="M6 50a44 44 0 0 1 88 0z" fill="#ee2b37"/>
    <rect x="5" y="46" width="90" height="8" fill="#1b1b1b"/>
    <circle cx="50" cy="50" r="15" fill="#f5f5f5" stroke="#1b1b1b" stroke-width="7"/>
    <circle cx="50" cy="50" r="6" fill="#dcdcdc" stroke="#1b1b1b" stroke-width="3"/>
  </svg>`;
}

// Trainer category icons (white line-art on the card's banner color).
const TRAINER = {
  item:
    '<path d="M9 3h6v2l-1 1v3l3.6 7.4A2 2 0 0 1 14.8 19H9.2a2 2 0 0 1-1.8-2.6L11 9V6l-2-1z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  supporter:
    '<circle cx="12" cy="8" r="3.6" fill="currentColor"/><path d="M5 20a7 7 0 0 1 14 0z" fill="currentColor"/>',
  stadium:
    '<ellipse cx="12" cy="14" rx="9" ry="4.8" fill="none" stroke="currentColor" stroke-width="1.7"/><ellipse cx="12" cy="14" rx="4.2" ry="2" fill="currentColor"/><path d="M5 9.5V6.5M19 9.5V6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5 6.5h2.6v1.8H5zM19 6.5h-2.6v1.8H19z" fill="currentColor"/>',
};
export function trainerSVG(kind) {
  return `<svg viewBox="0 0 24 24" class="tcg-tsvg" aria-hidden="true">${TRAINER[kind] || TRAINER.item}</svg>`;
}

// Small pile icons for the opponent status bar.
const PILE = {
  hand: '<g fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8.5" y="7" width="7" height="10" rx="1" transform="rotate(-15 12 12)"/><rect x="8.5" y="7" width="7" height="10" rx="1"/><rect x="8.5" y="7" width="7" height="10" rx="1" transform="rotate(15 12 12)"/></g>',
  deck: '<rect x="6" y="4" width="12" height="16" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 4V2.5M15 4V2.5" stroke="currentColor" stroke-width="1.5"/>',
  discard: '<rect x="6" y="4" width="12" height="16" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};
export function pileSVG(which) {
  return `<svg viewBox="0 0 24 24" class="tcg-pilesvg" aria-hidden="true">${PILE[which] || PILE.deck}</svg>`;
}

export function trophySVG() {
  return `<svg viewBox="0 0 24 24" class="tcg-trophy" aria-hidden="true">
    <path d="M7 4h10v3a5 5 0 0 1-10 0z" fill="#f7d02c" stroke="#a97b12" stroke-width="1"/>
    <path d="M7 5H4v1a3 3 0 0 0 3 3M17 5h3v1a3 3 0 0 1-3 3" fill="none" stroke="#f7d02c" stroke-width="1.6"/>
    <path d="M10 12h4l.5 3h-5z" fill="#f7d02c"/><rect x="8" y="15" width="8" height="2.4" rx="1" fill="#f7d02c"/>
  </svg>`;
}
