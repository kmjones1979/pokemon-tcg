import { test } from "node:test";
import assert from "node:assert/strict";
import { abilitiesFor, basicAbility, specialAbility, abilityById } from "../client/js/abilities.js";
import { computeDamage } from "../client/js/battle.js";

function mkCard({ type = "normal", cardAttack = 6, hp = 100 } = {}) {
  return {
    name: "Test",
    types: [type],
    cardAttack,
    cardHp: Math.round(hp / 10),
    raw: { hp, attack: cardAttack * 30, defense: 30, sp_defense: 30, sp_attack: 0 },
  };
}

test("every Pokémon gets a basic + special ability", () => {
  for (const type of ["normal","fire","water","electric","grass","psychic","dragon"]) {
    const card = mkCard({ type });
    const list = abilitiesFor(card);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "basic");
    assert.equal(list[1].id, "special");
    assert.equal(list[0].energyCost, 0);
    assert.ok(list[1].energyCost >= 1);
  }
});

test("special damage > basic damage for the same matchup", () => {
  const attacker = mkCard({ type: "fire", cardAttack: 6 });
  const defender = mkCard({ type: "grass" });
  const basic = computeDamage(attacker, defender, { ability: basicAbility(attacker) });
  const special = computeDamage(attacker, defender, { ability: specialAbility(attacker) });
  assert.ok(special.damage > basic.damage, `special ${special.damage} should beat basic ${basic.damage}`);
});

test("flying special ignores defense", () => {
  const flying = mkCard({ type: "flying", cardAttack: 4 });
  const heavy = mkCard({ type: "rock" });
  // Stack the defender with huge defense to make the difference obvious.
  heavy.raw.defense = 300;
  heavy.raw.sp_defense = 300;
  const basic = computeDamage(flying, heavy, { ability: basicAbility(flying) });
  const special = computeDamage(flying, heavy, { ability: specialAbility(flying) });
  // Flying is 2× vs rock... wait no, flying is 0.5× vs rock. But the special
  // ignores defense regardless of type matchup.
  assert.ok(special.ignoredDefense, "should report ignoredDefense flag");
});

test("abilityById falls back to basic for unknown ids", () => {
  const c = mkCard();
  assert.equal(abilityById(c, "nonsense").id, "basic");
  assert.equal(abilityById(c, "special").id, "special");
});

test("fire special carries guaranteed burn status", () => {
  const ab = specialAbility(mkCard({ type: "fire" }));
  assert.equal(ab.status, "burn");
});

test("psychic special carries guaranteed sleep status", () => {
  const ab = specialAbility(mkCard({ type: "psychic" }));
  assert.equal(ab.status, "sleep");
});
