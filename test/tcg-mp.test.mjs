// Multiplayer view scrubbing. The server is authoritative and each player
// polls a per-recipient VIEW — this must never leak the opponent's hand, deck,
// or face-down Prizes, and must present the recipient as "player" regardless of
// their real seat. A regression here is an information-leak cheat.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../client/js/tcg/engine.js";
import { deckById } from "../client/js/tcg/decks.js";
import mpTcg from "../server-modules/multiplayer-tcg.js";

const { viewFor } = mpTcg;

function makeMatch() {
  E.setRng(() => 0.42);
  const state = E.createTcgGame({
    playerDeckIds: deckById("fire").cards, aiDeckIds: deckById("water").cards,
    playerName: "Ash", aiName: "Gary", firstPlayer: "player",
  });
  return {
    id: "m1", v: 3,
    players: { player: { playerId: "pA", displayName: "Ash", side: "player" }, ai: { playerId: "pB", displayName: "Gary", side: "ai" } },
    state,
  };
}
const allHidden = (arr) => arr.length > 0 && arr.every((c) => c && c.hidden === true);

test("viewFor hides the opponent's hand, deck, and both players' Prizes", () => {
  const m = makeMatch();
  const view = viewFor(m, "player"); // recipient is the real "player" seat

  // Own hand is real cards; opponent's hand is length-preserving but hidden.
  assert.ok(view.players.player.hand.some((c) => c && c.kind), "own hand visible");
  assert.equal(view.players.ai.hand.length, m.state.players.ai.hand.length, "opp hand size preserved");
  assert.ok(allHidden(view.players.ai.hand), "opp hand hidden");

  // Opponent deck contents hidden (length preserved for the pile count).
  assert.ok(allHidden(view.players.ai.deck), "opp deck hidden");
  assert.equal(view.players.ai.deck.length, m.state.players.ai.deck.length);

  // Prizes are face-down to EVERYONE, including their owner.
  assert.ok(allHidden(view.players.player.prizes), "own prizes hidden");
  assert.ok(allHidden(view.players.ai.prizes), "opp prizes hidden");
  assert.equal(view.players.player.prizes.length, 6);
});

test("viewFor presents the recipient as 'player' from either seat", () => {
  const m = makeMatch(); // real activePlayer is "player" (firstPlayer)
  const asPlayer = viewFor(m, "player");
  const asAi = viewFor(m, "ai");
  assert.equal(asPlayer.youAre, "player");
  assert.equal(asAi.youAre, "player");
  // Same underlying turn, mirrored: the first player sees "player" active, the
  // opponent sees "ai" active.
  assert.equal(asPlayer.activePlayer, "player");
  assert.equal(asAi.activePlayer, "ai");
  // Each sees the OTHER as their opponent.
  assert.equal(asPlayer.opponent.displayName, "Gary");
  assert.equal(asAi.opponent.displayName, "Ash");
});

test("viewFor carries the match version and flips a winner to the recipient POV", () => {
  const m = makeMatch();
  m.state.winner = "player";
  assert.equal(viewFor(m, "player").winner, "player", "winner sees themselves win");
  assert.equal(viewFor(m, "ai").winner, "ai", "loser sees opponent (ai) win");
  assert.equal(viewFor(m, "player").v, 3, "version passed through");
});
