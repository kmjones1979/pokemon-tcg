// TCG AI opponent: drive full AI-vs-AI games and assert the policy never
// throws, preserves card conservation, terminates in a sane number of turns,
// and resolves games via knockouts rather than grindy deck-outs.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../client/js/tcg/engine.js";
import { aiTakeTurn } from "../client/js/tcg/ai.js";
import { STARTER_DECKS } from "../client/js/tcg/decks.js";

function seed(n) {
  let a = n >>> 0;
  E.setRng(() => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}
function countCards(s) {
  let n = s.deck.length + s.hand.length + s.discard.length + s.prizes.length;
  for (const i of (s.active ? [s.active, ...s.bench] : s.bench)) n += 1 + i.under.length + i.attached.length;
  return n;
}

test("AI self-play: no exceptions, conservation, termination, KO-driven finishes", async () => {
  let games = 0, trueDeckouts = 0, longest = 0, turnsSum = 0;
  for (let g = 0; g < 120; g++) {
    seed(5000 + g);
    const st = E.createTcgGame({
      playerDeckIds: STARTER_DECKS[g % 3].cards,
      aiDeckIds: STARTER_DECKS[(g + 2) % 3].cards,
      firstPlayer: g % 2 ? "player" : "ai",
    });
    let guard = 0;
    while (!st.winner && guard++ < 500) {
      await aiTakeTurn(st, st.activePlayer);       // never throws
      assert.equal(countCards(st.players.player), 60, `player conservation game ${g}`);
      assert.equal(countCards(st.players.ai), 60, `ai conservation game ${g}`);
    }
    assert.ok(st.winner === "player" || st.winner === "ai", `game ${g} has a winner`);
    // A TRUE deck-out: not an all-Prizes win (winner still has Prizes) and not
    // a board wipe (loser still has a Pokémon in play) — the loser simply
    // couldn't draw. This must stay rare; a spike would mean the AI is burning
    // its own deck (the bug the deck-aware digging logic prevents).
    const loser = st.winner === "player" ? "ai" : "player";
    const l = st.players[loser];
    if (st.players[st.winner].prizes.length > 0 && (l.active || l.bench.length)) trueDeckouts++;
    longest = Math.max(longest, st.turn);
    turnsSum += st.turn;
    games++;
  }
  assert.equal(games, 120);
  assert.ok(longest < 500, `longest game ${longest} turns`);
  assert.ok(turnsSum / games < 40, `avg game length ${(turnsSum / games).toFixed(1)} turns too long`);
  assert.ok(trueDeckouts <= 4, `too many true deck-out finishes: ${trueDeckouts}/120`);
});
