// Native Flashcards. All rendering and interaction stays inside the public plugin API.
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const append = (parent, ...children) => { parent.append(...children); return parent; };
const message = error => error instanceof Error ? error.message : String(error);
const uuid = () => crypto.randomUUID();
const ratings = ["Again", "Hard", "Good", "Easy"];
const activeBatch = batch => batch && ["running", "pending", "queued", "cancelling"].includes(batch.status);
const interval = ms => {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
};
function lifetime(...parents) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const parent of parents) {
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
  }
  controller.signal.addEventListener("abort", () => {
    for (const parent of parents) parent.removeEventListener("abort", abort);
  }, { once: true });
  return controller;
}
function parseSteps(text) {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (!parts.length) throw new Error("Enter at least one learning step.");
  const values = parts.map(part => {
    const match = /^(\d+)(m|h)?$/i.exec(part);
    if (!match) throw new Error("Use whole minutes, separated by spaces or commas (for example 1m 10m).");
    return Number(match[1]) * (match[2]?.toLowerCase() === "h" ? 60 : 1);
  });
  if (values.some((value, index) => !Number.isSafeInteger(value) || value <= 0 || value >= 1440 || (index > 0 && value <= values[index - 1]))) {
    throw new Error("Steps must be increasing positive whole minutes, each shorter than one day.");
  }
  return values;
}

export function activate(ctx) {
  for (const capability of ["mountMarkdown", "mountKnowledgePicker"]) {
    if (typeof ctx.ui?.[capability] !== "function") {
      throw new Error(`Flashcards requires a newer LearnHarness host with ctx.ui.${capability}. Please update LearnHarness.`);
    }
  }
  let snapshot = null;
  let refreshing = null;
  let refreshAgain = false;
  const observers = new Set();
  const registrations = [];
  const publish = value => {
    if (!value || ctx.signal.aborted) return;
    if (snapshot && typeof value.revision === "number" && value.revision < snapshot.revision) return;
    snapshot = value;
    for (const observer of observers) observer(value);
  };
  const report = error => { for (const observer of observers) observer(null, message(error)); };
  const refresh = () => {
    if (!observers.size || ctx.signal.aborted) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        try { const state = await ctx.call("get-state"); if (observers.size) publish(state); }
        catch (error) { if (observers.size) report(error); }
      } while (refreshAgain && observers.size && !ctx.signal.aborted);
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  const observe = (fn, signal) => {
    observers.add(fn);
    signal.addEventListener("abort", () => observers.delete(fn), { once: true });
    if (snapshot) fn(snapshot);
    void refresh();
  };
  function widget(handle, signal) {
    if (signal.aborted) handle.dispose();
    else signal.addEventListener("abort", () => handle.dispose(), { once: true });
    return handle;
  }
  function button(parent, label, action, signal, options = {}) {
    const slot = el("span", "fc-button");
    parent.append(slot);
    let pending = false, disabled = !!options.disabled;
    const handle = widget(ctx.ui.mountButton(slot, {
      label, size: "sm", variant: "outline", ...options,
      onClick: async () => {
        if (pending || signal.aborted || disabled) return;
        pending = true;
        handle.update({ disabled: true });
        try { await action(); }
        finally { pending = false; if (!signal.aborted) handle.update({ disabled }); }
      },
    }, { signal }), signal);
    return {
      update(props) {
        if (Object.hasOwn(props, "disabled")) disabled = props.disabled;
        handle.update({ ...props, disabled: pending || disabled });
      },
      dispose: () => handle.dispose(),
    };
  }
  function markdown(parent, text, signal) {
    const slot = el("div", "fc-markdown");
    parent.append(slot);
    widget(ctx.ui.mountMarkdown(slot, { text: text || "" }, { signal }), signal);
  }
  async function mutate(operation, input, signal) {
    const value = await ctx.call(operation, input);
    if (signal.aborted) return false;
    publish(value);
    return true;
  }
  function field(parent, label, value, type = "text") {
    const wrapper = el("label", "fc-field");
    const input = el(type === "textarea" ? "textarea" : "input", "fc-input");
    if (type !== "textarea") input.type = type;
    input.value = String(value ?? "");
    wrapper.append(el("span", "fc-label", label), input);
    parent.append(wrapper);
    return input;
  }
  function dialog(title, parentSignal, build) {
    let handle;
    handle = ctx.ui.openDialog({ title, content: (container, hostSignal) => {
      const scope = lifetime(parentSignal, hostSignal, ctx.signal);
      const root = el("div", "fc-root fc-dialog");
      const error = el("p", "fc-error");
      error.setAttribute("role", "alert");
      container.append(root);
      const actions = el("div", "fc-actions");
      const run = action => async () => {
        try { await action(); }
        catch (cause) { if (!scope.signal.aborted) error.textContent = message(cause); }
      };
      build({ root, actions, signal: scope.signal, run, close: () => handle?.dispose() });
      root.append(error, actions);
      button(actions, "Cancel", () => handle?.dispose(), scope.signal, { variant: "ghost" });
      return () => { scope.abort(); root.remove(); };
    } }, { signal: parentSignal });
    return widget(handle, parentSignal);
  }
  function confirmGeneration(propositionIds, signal, showError) {
    return (async () => {
      try {
        const preflight = await ctx.call("preflight", { propositionIds: [...propositionIds] });
        if (signal.aborted) return;
        const requestId = uuid();
        dialog("Generate flashcards", signal, ({ root, actions, signal: dialogSignal, run, close }) => {
          root.append(el("p", "", `${preflight.propositionCount} propositions · ${preflight.chunkCount} chunks · approximately ${preflight.estimatedTokens.toLocaleString()} input tokens · ${preflight.modelLabel}`));
          root.append(el("p", "fc-muted", "Generation makes model calls and may incur costs. Adds useful missing cues while preserving existing cards and review history. Work continues when you leave this view."));
          button(actions, "Start", run(async () => {
            if (await mutate("start-generation", { preflightId: preflight.id, requestId }, dialogSignal)) close();
          }), dialogSignal, { variant: "default" });
        });
      } catch (error) { if (!signal.aborted) showError(message(error)); }
    })();
  }
  function editCue(proposition, cue, signal) {
    dialog("Edit cue", signal, ({ root, actions, signal: ds, run, close }) => {
      const question = field(root, "Question (Markdown)", cue.question, "textarea");
      const answer = field(root, "Answer (Markdown)", cue.answer, "textarea");
      button(actions, "Save", run(async () => {
        if (await mutate("save-cue", { propositionId: proposition.id, cueId: cue.id, question: question.value, answer: answer.value, version: proposition.version }, ds)) close();
      }), ds, { variant: "default" });
    });
  }
  function deleteCue(proposition, cue, signal) {
    dialog("Delete cue?", signal, ({ root, actions, signal: ds, run, close }) => {
      root.append(el("p", "", "Remove this cue from review? The proposition's other cues and history are retained."));
      button(actions, "Delete cue", run(async () => {
        if (await mutate("delete-cue", { propositionId: proposition.id, cueId: cue.id, version: proposition.version }, ds)) close();
      }), ds, { variant: "destructive" });
    });
  }
  function memberships(proposition, state, signal) {
    dialog("Deck memberships", signal, ({ root, actions, signal: ds, run, close }) => {
      root.append(el("p", "fc-muted", "Memberships share the same cues, schedule, and history. Keep at least one deck."));
      const choices = state.decks.map(deck => {
        const label = el("label", "fc-check");
        const input = el("input");
        input.type = "checkbox";
        input.checked = proposition.memberships.includes(deck.id);
        label.append(input, document.createTextNode(deck.name));
        root.append(label);
        return { id: deck.id, input };
      });
      button(actions, "Save memberships", run(async () => {
        const deckIds = choices.filter(choice => choice.input.checked).map(choice => choice.id);
        if (!deckIds.length) throw new Error("Choose at least one deck.");
        if (await mutate("set-memberships", { propositionId: proposition.id, deckIds }, ds)) close();
      }), ds, { variant: "default" });
    });
  }
  function editDeck(deck, state, signal) {
    dialog(deck ? "Deck settings" : "Create deck", signal, ({ root, actions, signal: ds, run, close }) => {
      const name = field(root, "Deck name", deck?.name || "");
      const limit = deck ? field(root, "New propositions per day", deck.newLimit, "number") : null;
      if (limit) { limit.min = "0"; limit.step = "1"; }
      button(actions, deck ? "Save" : "Create", run(async () => {
        if (!name.value.trim()) throw new Error("Enter a deck name.");
        const input = deck ? { id: deck.id, name: name.value, newLimit: Number(limit.value) } : { name: name.value };
        if (await mutate(deck ? "save-deck" : "create-deck", input, ds)) close();
      }), ds, { variant: "default" });
      if (deck) button(actions, "Delete deck…", () => {
        dialog("Delete deck?", ds, ({ root: body, actions: footer, signal: deletionSignal, run: guarded, close: finish }) => {
          const needsReplacement = state.propositions.some(p => p.memberships.includes(deck.id) && p.memberships.length === 1);
          body.append(el("p", "", "Only the collection is deleted. Cards, schedules, and history are preserved."));
          const otherDecks = state.decks.filter(d => d.id !== deck.id);
          let replacement;
          if (needsReplacement) {
            const label = el("label", "fc-field");
            replacement = el("select", "fc-input");
            replacement.append(append(el("option"), document.createTextNode("Choose replacement deck")));
            for (const candidate of otherDecks) {
              const option = el("option", "", candidate.name); option.value = candidate.id; replacement.append(option);
            }
            replacement.options[0].value = "";
            label.append(el("span", "fc-label", "Replacement for propositions with no other membership"), replacement);
            body.append(label);
            if (!otherDecks.length) body.append(el("p", "fc-muted", "Create another deck before deleting this one."));
          }
          button(footer, "Delete deck", guarded(async () => {
            if (needsReplacement && !replacement.value) throw new Error("Choose a replacement deck.");
            if (await mutate("delete-deck", { id: deck.id, ...(needsReplacement ? { replacementDeckId: replacement.value } : {}) }, deletionSignal)) { finish(); close(); }
          }), deletionSignal, { variant: "destructive", disabled: needsReplacement && !otherDecks.length });
        });
      }, ds, { variant: "destructive" });
    });
  }

  function mountLibrary(container, hostSignal) {
    const view = lifetime(hostSignal, ctx.signal);
    const signal = view.signal;
    const root = el("div", "fc-root fc-library");
    const error = el("p", "fc-error"); error.setAttribute("role", "alert");
    const showError = text => { if (!signal.aborted) error.textContent = text; };
    const guarded = action => async () => { try { await action(); } catch (cause) { showError(message(cause)); } };
    function moveControls(parent, kind, id, ids, controlSignal, context = {}) {
      const index = ids.indexOf(id);
      const searching = !!search.value.trim();
      for (const direction of [-1, 1]) button(parent, direction === -1 ? "Up" : "Down", guarded(() => mutate("reorder", { kind, id, ...context, direction }, controlSignal)), controlSignal, {
        variant: "ghost", size: "xs", title: searching ? "Clear search to reorder" : `Move ${kind} ${direction === -1 ? "up" : "down"}`,
        disabled: searching || index < 0 || (direction === -1 ? index === 0 : index === ids.length - 1),
      });
    }
    const toolbar = el("div", "fc-toolbar");
    const pickerSlot = el("div", "fc-picker");
    let generationIds = [];
    let generationButton;
    const picker = widget(ctx.ui.mountKnowledgePicker(pickerSlot, { value: generationIds, onChange: ids => {
      generationIds = [...ids]; picker.update({ value: generationIds });
      generationButton?.update({ disabled: !generationIds.length || !!activeBatch(snapshot?.batch) });
    } }, { signal }), signal);
    toolbar.append(pickerSlot);
    generationButton = button(toolbar, "Generate", () => confirmGeneration(generationIds, signal, showError), signal, { disabled: true, variant: "default" });
    button(toolbar, "Create deck", () => editDeck(null, snapshot, signal), signal);
    button(toolbar, "Review all", () => startReview({}), signal);
    const selected = new Set();
    const reviewSelected = button(toolbar, "Review selected", () => startReview({ propositionIds: [...selected] }), signal, { disabled: true });
    const searchLabel = el("label", "fc-search");
    const search = el("input", "fc-input"); search.type = "search"; search.placeholder = "Search decks, propositions, and cues"; search.setAttribute("aria-label", "Search flashcards");
    searchLabel.append(search);
    const batchArea = el("div");
    const reviewArea = el("section", "fc-review"); reviewArea.tabIndex = 0; reviewArea.setAttribute("aria-label", "Flashcard review"); reviewArea.hidden = true;
    const tree = el("div", "fc-tree");
    root.append(toolbar, searchLabel, error, batchArea, reviewArea, tree);
    container.append(root);
    let treeScope = lifetime(signal), batchScope = lifetime(signal), cardScope = lifetime(signal);
    let reviewFilter = null, ticket = null, revealed = false;
    let reviewSerial = 0;
    let reviewRequests = new Map();
    let revealAction = null, rateAction = null;
    let waitTimer = null;
    const expanded = new Set();
    const clearWait = () => { if (waitTimer !== null) clearTimeout(waitTimer); waitTimer = null; };
    signal.addEventListener("abort", clearWait, { once: true });
    function cardReset() {
      clearWait(); cardScope.abort(); cardScope = lifetime(signal);
      reviewArea.replaceChildren(); revealAction = null; rateAction = null;
    }
    function stopReview() {
      reviewSerial++; reviewFilter = null; ticket = null; cardReset(); reviewArea.hidden = true;
    }
    function reviewChrome() {
      reviewArea.hidden = false;
      const actions = el("div", "fc-actions"); reviewArea.append(actions);
      button(actions, "End review", stopReview, cardScope.signal, { variant: "ghost" });
    }
    function startReview(filter) { reviewFilter = filter; void nextReview(); }
    async function nextReview() {
      const serial = ++reviewSerial;
      ticket = null; revealed = false; reviewRequests = new Map();
      cardReset(); reviewChrome();
      reviewArea.append(el("p", "fc-muted", "Loading next card…"));
      const cs = cardScope.signal;
      try {
        const result = await ctx.call("next-review", reviewFilter);
        if (signal.aborted || cs.aborted || serial !== reviewSerial) return;
        cardReset(); reviewChrome();
        if (!result.ticket) {
          reviewArea.append(el("p", "", result.nextDue ? `No cards ready. Next due ${new Date(result.nextDue).toLocaleString()}.` : "No cards due in this selection."));
          if (result.nextDue) {
            const arm = () => {
              if (cardScope.signal.aborted || signal.aborted || serial !== reviewSerial || reviewFilter === null) return;
              const delay = result.nextDue - Date.now();
              waitTimer = setTimeout(() => { waitTimer = null; if (delay > 2147483647) arm(); else void nextReview(); }, Math.min(2147483647, Math.max(100, delay)));
            };
            arm();
          }
          return;
        }
        ticket = result.ticket;
        reviewArea.append(el("p", "fc-muted", `${ticket.propositionName}${result.remaining === undefined ? "" : ` · ${result.remaining} remaining`}`));
        markdown(reviewArea, ticket.question, cardScope.signal);
        const answerArea = el("div", "fc-answer"); reviewArea.append(answerArea);
        const controls = el("div", "fc-actions"); reviewArea.append(controls);
        const cardError = el("p", "fc-error"); cardError.setAttribute("role", "alert"); reviewArea.append(cardError);
        const current = ticket;
        const currentSignal = cardScope.signal;
        let revealButton, retryNextButton, ratingBusy = false, revealBusy = false;
        const retryNext = () => {
          if (!retryNextButton) retryNextButton = button(reviewArea, "Retry next card", nextReview, currentSignal);
        };
        revealAction = async () => {
          if (revealBusy || revealed || currentSignal.aborted) return;
          revealBusy = true; revealButton.update({ disabled: true });
          try {
            const result = await ctx.call("reveal-review", { ticketId: current.id });
            if (currentSignal.aborted || serial !== reviewSerial) return;
            revealed = true; cardError.textContent = "";
            markdown(answerArea, result.answer, currentSignal);
            revealButton.dispose(); controls.replaceChildren();
            const ratingButtons = [];
            rateAction = async rating => {
              if (ratingBusy || currentSignal.aborted) return;
              ratingBusy = true; ratingButtons.forEach(handle => handle.update({ disabled: true }));
              if (!reviewRequests.has(rating)) reviewRequests.set(rating, uuid());
              try {
                await ctx.call("rate-review", { ticketId: current.id, rating, requestId: reviewRequests.get(rating) });
                if (currentSignal.aborted || serial !== reviewSerial) return;
                void refresh(); await nextReview();
              } catch (cause) { if (!currentSignal.aborted) { cardError.textContent = message(cause); retryNext(); } }
              finally { ratingBusy = false; if (!currentSignal.aborted) ratingButtons.forEach(handle => handle.update({ disabled: false })); }
            };
            ratings.forEach((label, index) => ratingButtons.push(button(controls, `${index + 1} ${label} · ${interval(result.intervals[index + 1])}`, () => rateAction?.(index + 1), currentSignal, { variant: index === 2 ? "default" : "outline" })));
            reviewArea.focus({ preventScroll: true });
          } catch (cause) { if (!currentSignal.aborted) { cardError.textContent = message(cause); retryNext(); } }
          finally { revealBusy = false; if (!currentSignal.aborted && !revealed) revealButton.update({ disabled: false }); }
        };
        revealButton = button(controls, "Reveal answer · Space", () => revealAction?.(), currentSignal, { variant: "default" });
        reviewArea.focus({ preventScroll: true });
      } catch (cause) {
        if (signal.aborted || cs.aborted || serial !== reviewSerial) return;
        cardReset(); reviewChrome();
        reviewArea.append(el("p", "fc-error", message(cause)));
        button(reviewArea, "Retry next card", nextReview, cardScope.signal);
      }
    }
    reviewArea.addEventListener("keydown", event => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.target.closest("input,textarea,select,button,a,[contenteditable=true]")) return;
      if (event.code === "Space") { event.preventDefault(); if (revealed) void rateAction?.(3); else void revealAction?.(); }
      else if (revealed && /^[1-4]$/.test(event.key)) { event.preventDefault(); void rateAction?.(Number(event.key)); }
    }, { signal });
    function disclosure(parent, key, label, scopeSignal, body) {
      const details = el("details", "fc-folder");
      details.open = expanded.has(key) || !!search.value.trim();
      details.append(el("summary", "", label));
      const content = el("div", "fc-folder-body"); details.append(content); parent.append(details);
      let inner = null;
      const sync = () => {
        if (details.open) {
          expanded.add(key);
          if (!inner) { inner = lifetime(scopeSignal); body(content, inner.signal); }
        } else {
          expanded.delete(key); inner?.abort(); inner = null; content.replaceChildren();
        }
      };
      details.addEventListener("toggle", sync, { signal: scopeSignal });
      sync();
    }
    function renderTree(state) {
      treeScope.abort(); treeScope = lifetime(signal); tree.replaceChildren();
      const ts = treeScope.signal;
      const query = search.value.toLocaleLowerCase().trim();
      const matches = p => !query || [p.name, p.statement, ...p.cues.filter(c => !c.deleted).flatMap(c => [c.question, c.answer])].some(text => String(text || "").toLocaleLowerCase().includes(query));
      const live = state.propositions.filter(p => !p.archived);
      const validIds = new Set(live.map(p => p.id));
      for (const id of selected) if (!validIds.has(id)) selected.delete(id);
      reviewSelected.update({ disabled: !selected.size, label: selected.size ? `Review selected (${selected.size})` : "Review selected" });
      const propRow = (parent, p, ps, archive = false, deck = null) => disclosure(parent, `${archive ? "archive" : "prop"}:${p.id}:${parent.dataset.deck || ""}`, `${p.name} · ${p.cues.filter(c => !c.deleted).length} cues`, ps, (body, bs) => {
        if (p.statement) markdown(body, p.statement, bs);
        const actions = el("div", "fc-actions"); body.append(actions);
        if (!archive) {
          const choice = el("label", "fc-check"); const checkbox = el("input"); checkbox.type = "checkbox"; checkbox.checked = selected.has(p.id);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) selected.add(p.id); else selected.delete(p.id);
            tree.querySelectorAll("input[data-proposition]").forEach(input => { if (input.dataset.proposition === p.id) input.checked = selected.has(p.id); });
            reviewSelected.update({ disabled: !selected.size, label: selected.size ? `Review selected (${selected.size})` : "Review selected" });
          }, { signal: bs });
          checkbox.dataset.proposition = p.id; choice.append(checkbox, document.createTextNode("Select for review")); actions.append(choice);
          button(actions, "Review", () => startReview({ propositionIds: [p.id] }), bs);
          button(actions, "Decks…", () => memberships(p, state, signal), bs);
          if (deck) moveControls(actions, "proposition", p.id, deck.propositionIds, bs, { deckId: deck.id });
        }
        for (const cue of p.cues.filter(c => !c.deleted)) disclosure(body, `cue:${p.id}:${cue.id}:${parent.dataset.deck || ""}:${archive}`, cue.question.replace(/\s+/g, " ").slice(0, 100) || "Cue", bs, (card, qs) => {
          card.append(el("div", "fc-label", "Question")); markdown(card, cue.question, qs);
          card.append(el("div", "fc-label", "Answer")); markdown(card, cue.answer, qs);
          if (cue.latestRating) card.append(el("p", "fc-muted", `Latest rating: ${ratings[cue.latestRating - 1]}`));
          if (!archive) {
            const controls = el("div", "fc-actions"); card.append(controls);
            button(controls, "Edit", () => editCue(p, cue, signal), qs);
            button(controls, "Delete", () => deleteCue(p, cue, signal), qs, { variant: "ghost" });
            moveControls(controls, "cue", cue.id, p.cues.filter(c => !c.deleted).map(c => c.id), qs, { propositionId: p.id });
          }
        });
      });
      let shown = 0;
      for (const deck of state.decks) {
        const deckMatches = deck.name.toLocaleLowerCase().includes(query);
        const byId = new Map(live.map(p => [p.id, p]));
        const props = deck.propositionIds.map(id => byId.get(id)).filter(p => p && p.memberships.includes(deck.id) && (deckMatches || matches(p)));
        if (query && !props.length && !deckMatches) continue;
        shown++;
        disclosure(tree, `deck:${deck.id}`, `${deck.name} · ${props.length} propositions · ${deck.due} due · ${deck.newToday}/${deck.newLimit} new today`, ts, (body, ds) => {
          body.dataset.deck = deck.id;
          const controls = el("div", "fc-actions"); body.append(controls);
          button(controls, "Review deck", () => startReview({ deckIds: [deck.id] }), ds);
          button(controls, "Deck settings", () => editDeck(deck, state, signal), ds);
          moveControls(controls, "deck", deck.id, state.decks.map(d => d.id), ds);
          for (const proposition of props) propRow(body, proposition, ds, false, deck);
          if (!props.length) body.append(el("p", "fc-muted", "No propositions in this deck."));
        });
      }
      const archived = state.propositions.filter(p => p.archived && matches(p));
      if (archived.length) {
        shown++;
        disclosure(tree, "archive", `Archive · ${archived.length} propositions`, ts, (body, as) => {
          body.append(el("p", "fc-muted", "These propositions are no longer in the graph. Their saved cards and history are retained outside review."));
          for (const proposition of archived) propRow(body, proposition, as, true);
        });
      }
      if (!shown) tree.append(el("p", "fc-muted", query ? "No matching flashcards." : "No flashcards yet. Pick knowledge above to generate your first cues."));
    }
    function renderBatch(batch) {
      batchScope.abort(); batchScope = lifetime(signal); batchArea.replaceChildren();
      if (!batch) return;
      const bs = batchScope.signal;
      const panel = el("section", "fc-batch"); batchArea.append(panel);
      panel.append(el("p", "", `Generation: ${batch.status} · ${batch.completed}/${batch.total} chunks · ${batch.added} cues added`));
      const failures = batch.chunks.filter(chunk => chunk.error);
      for (const chunk of failures) panel.append(el("p", "fc-error", `Chunk ${chunk.id}: ${chunk.error}`));
      if (batch.error) panel.append(el("p", "fc-error", batch.error));
      const controls = el("div", "fc-actions"); panel.append(controls);
      if (activeBatch(batch)) button(controls, "Cancel generation", guarded(() => mutate("cancel-generation", { batchId: batch.id }, signal)), bs);
      if (!activeBatch(batch) && batch.failedTargetIds?.length) button(controls, "Retry failed…", () => confirmGeneration(batch.failedTargetIds, signal, showError), bs);
      if (batch.error) button(controls, "Retry saving", guarded(() => mutate("resume-results", {}, signal)), bs);
    }
    search.addEventListener("input", () => { if (snapshot) renderTree(snapshot); }, { signal });
    observe((state, loadError) => {
      if (signal.aborted) return;
      if (loadError) { showError(loadError); return; }
      generationButton.update({ disabled: !generationIds.length || !!activeBatch(state.batch) });
      renderBatch(state.batch); renderTree(state);
    }, signal);
    return () => { view.abort(); root.remove(); };
  }

  function mountSettings(container, hostSignal) {
    const scope = lifetime(hostSignal, ctx.signal);
    const signal = scope.signal;
    const root = el("div", "fc-root fc-settings");
    const error = el("p", "fc-error"); error.setAttribute("role", "alert");
    const fields = el("div"); const modelArea = el("div", "fc-model-settings");
    root.append(fields, modelArea, error); container.append(root);
    let initialized = false, rows, modelPicker, thinkingPicker, thinkingDefaultButton, catalog = null;
    const showError = cause => { if (!signal.aborted) error.textContent = message(cause); };
    const save = async patch => {
      try {
        const state = await ctx.call("save-settings", patch);
        if (signal.aborted) return;
        error.textContent = ""; publish(state);
        rows?.update({ rows: settingsRows(snapshot.settings) }); updateModels(snapshot.settings);
      } catch (cause) { showError(cause); throw cause; }
    };
    const settingsRows = settings => {
      const row = (key, label, value, type, parse = value => value, extras = {}) => ({
        key, label, value, type, ...extras, onChange: async value => {
          try { await save({ [key]: parse(value) }); } catch (cause) { showError(cause); throw cause; }
        },
      });
      return [
        row("retention", "Desired retention (%)", settings.retention * 100, "number", value => Number(value) / 100, { min: 70, max: 99, step: 1 }),
        row("learningSteps", "Learning steps (minutes)", settings.learningSteps.map(value => `${value}m`).join(" "), "text", parseSteps),
        row("relearningSteps", "Relearning steps (minutes)", settings.relearningSteps.map(value => `${value}m`).join(" "), "text", parseSteps),
        row("dayStart", "Day starts at (hour)", settings.dayStart, "number", Number, { min: 0, max: 23, step: 1 }),
        row("chunkBudget", "Generation chunk budget (estimated tokens)", settings.chunkBudget, "number", Number, { min: 1, step: 1 }),
      ];
    };
    const updateModels = settings => {
      modelPicker?.update({ value: settings.modelOverride || undefined });
      thinkingPicker?.update({ model: settings.modelOverride || catalog?.slots?.cheap?.model || undefined, value: settings.thinkingOverride ?? (settings.modelOverride ? undefined : catalog?.slots?.cheap?.thinkingLevel) });
      thinkingDefaultButton?.update({ label: settings.modelOverride ? "Use model's default thinking" : "Follow cheap-slot thinking" });
    };
    observe((state, loadError) => {
      if (signal.aborted) return;
      if (loadError) { showError(loadError); return; }
      if (!initialized) {
        initialized = true;
        rows = widget(ctx.ui.mountSettingsRows(fields, { rows: settingsRows(state.settings) }, { signal }), signal);
        modelArea.append(el("p", "fc-muted", "Generation follows the current cheap model slot unless overridden here."));
        const modelSlot = el("div"); const thinkingSlot = el("div"); modelArea.append(modelSlot, thinkingSlot);
        modelPicker = widget(ctx.ui.mountModelPicker(modelSlot, { value: state.settings.modelOverride || undefined, onChange: async value => {
          try { await save({ modelOverride: value, thinkingOverride: null }); } catch { /* Draft and error stay visible. */ }
        } }, { signal }), signal);
        thinkingPicker = widget(ctx.ui.mountThinkingPicker(thinkingSlot, { model: state.settings.modelOverride || undefined, value: state.settings.thinkingOverride || undefined, onChange: async value => {
          try { await save({ thinkingOverride: value }); } catch { /* Error is shown by save. */ }
        } }, { signal }), signal);
        button(modelArea, "Follow cheap slot", async () => { try { await save({ modelOverride: null, thinkingOverride: null }); } catch { /* Error stays visible. */ } }, signal);
        thinkingDefaultButton = button(modelArea, state.settings.modelOverride ? "Use model's default thinking" : "Follow cheap-slot thinking", async () => { try { await save({ thinkingOverride: null }); } catch { /* Error stays visible. */ } }, signal);
        void ctx.call("get-catalog").then(value => { if (!signal.aborted) { catalog = value; updateModels(snapshot.settings); } }).catch(showError);
      } else { rows.update({ rows: settingsRows(state.settings) }); updateModels(state.settings); }
    }, signal);
    return () => { scope.abort(); root.remove(); };
  }

  registrations.push(ctx.registerView({ id: "library", name: "Flashcards", mount: mountLibrary }));
  registrations.push(ctx.registerAction({ id: "open", name: "Flashcards", run: () => ctx.app.openView("library") }));
  registrations.push(ctx.placeAction({ id: "open-sidebar", actionId: "open", location: "sidebar" }));
  registrations.push(ctx.placeAction({ id: "open-graph", actionId: "open", location: "graph" }));
  registrations.push(ctx.registerSettings(mountSettings));
  registrations.push(ctx.onNotification(event => {
    if ((!event.pluginId || event.pluginId === ctx.manifest.id) && ["changed", "batch-changed"].includes(event.topic)) void refresh();
  }));
  registrations.push(ctx.onResync(() => { void refresh(); }));
  registrations.push(ctx.onAppEvent(event => {
    if (["sources-changed", "activity-changed", "chats-changed"].includes(event.type)) void refresh();
  }));
  const dispose = () => { for (const unregister of registrations.splice(0).reverse()) unregister(); observers.clear(); };
  ctx.cleanup(dispose);
  return dispose;
}
