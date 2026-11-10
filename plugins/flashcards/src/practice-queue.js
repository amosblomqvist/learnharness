// Practice is a read-only snapshot, ordered by the saved deck/proposition/cue order.
export function buildPracticeCards(state, scope = {}) {
  if (!state) return [];
  const decks = scope.deckIds === undefined ? null : new Set(scope.deckIds);
  const propositions = scope.propositionIds === undefined ? null : new Set(scope.propositionIds);
  const cues = scope.cueIds === undefined ? null : new Set(scope.cueIds);
  const byId = new Map(state.propositions.filter(p => !p.archived).map(p => [p.id, p]));
  const seen = new Set(), cards = [];
  for (const deck of state.decks) {
    if (decks && !decks.has(deck.id)) continue;
    for (const id of deck.propositionIds) {
      const p = byId.get(id);
      if (!p || (propositions && !propositions.has(id))) continue;
      for (const cue of p.cues) {
        if (cue.deleted || seen.has(cue.id) || (cues && !cues.has(cue.id))) continue;
        seen.add(cue.id);
        cards.push({ propositionId: p.id, cueId: cue.id, propositionName: p.name, question: cue.question, answer: cue.answer });
      }
    }
  }
  return cards;
}
