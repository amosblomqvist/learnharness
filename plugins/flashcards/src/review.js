// Page-bound review, using only the public plugin UI and RPC contracts.
const ratings = ["Again", "Hard", "Good", "Easy"];
const ratingOptions = label => {
  const color = `var(--fc-rating-${label.toLowerCase()})`;
  const tint = percent => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
  return { variant: "custom", colors: {
    background: tint(12), text: color, border: tint(55),
    hover: { background: tint(20), border: tint(75) },
    active: { background: tint(28), border: color },
    focusVisible: { border: color, ring: tint(50) },
  } };
};
const message = error => error instanceof Error ? error.message : String(error);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const interval = ms => {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
};
function lifetime(...parents) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const parent of parents.filter(Boolean)) {
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
  }
  controller.signal.addEventListener("abort", () => {
    for (const parent of parents.filter(Boolean)) parent.removeEventListener("abort", abort);
  }, { once: true });
  // Already-aborted parents must not retain listeners on the other parents.
  if (controller.signal.aborted) for (const parent of parents.filter(Boolean)) parent.removeEventListener("abort", abort);
  return controller;
}

export function createReviewController({ ctx, signal, button, markdown, onRated }) {
  const owner = lifetime(signal, ctx.signal);
  let active = null;
  const dispose = () => { owner.abort(); active?.close(); };
  owner.signal.addEventListener("abort", () => active?.close(), { once: true });

  function present(scope, practiceCards) {
    const practice = practiceCards !== undefined;
    active?.close();
    if (owner.signal.aborted) return;
    const session = lifetime(owner.signal);
    // Progress belongs to the logical session, not a replayable presentation.
    let practiceIndex = 0;
    let handle, closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      session.abort();
      if (active?.close === close) active = null;
      handle?.dispose();
    };
    active = { close };
    const mount = (container, hostSignal) => {
      // A host presentation may remount (including development effect replay).
      // Its lifetime is narrower than the logical review session.
      if (closed || session.signal.aborted || hostSignal.aborted) return;
      const content = lifetime(session.signal, hostSignal);
      const root = el("div", `fc-root fc-review-surface${practice ? " fc-practice-surface" : ""}`);
      root.tabIndex = -1;
      const stage = el("div", "fc-review-stage"), title = el("h2", "fc-review-title");
      stage.tabIndex = -1;
      stage.setAttribute("role", "group");
      stage.setAttribute("aria-label", practice ? "Flashcard practice" : "Flashcard review");
      stage.setAttribute("data-plugin-initial-focus", "");
      title.hidden = true;
      const card = el("div", "fc-review-card"), footer = el("div", "fc-review-footer"), bottom = el("div", "fc-review-bottom");
      const practiceNote = practice ? el("p", "fc-review-meta fc-practice-note", "Practice mode does not change your review schedule.") : null;
      stage.append(title, card, bottom, footer);
      root.append(stage);
      if (practiceNote) root.append(practiceNote);
      container.append(root);
      let cardScope = null, timer = null, revealAction = null, rateAction = null, advanceAction = null, revealed = false;
      const focusOwned = () => {
        if (!content.signal.aborted && root.contains(document.activeElement)) root.focus({ preventScroll: true });
      };
      const clearWait = () => { if (timer !== null) clearTimeout(timer); timer = null; };
      const cleanup = () => { clearWait(); cardScope?.abort(); root.remove(); };
      content.signal.addEventListener("abort", cleanup, { once: true });
      function reset() {
        // Move focus before removing a currently focused control, never reclaim
        // focus from outside this surface. The permanent heading survives reset.
        if (card.contains(document.activeElement) || footer.contains(document.activeElement) || title.contains(document.activeElement)) focusOwned();
        clearWait(); cardScope?.abort(); cardScope = lifetime(content.signal);
        revealAction = null; rateAction = null; advanceAction = null; revealed = false;
        title.textContent = ""; title.hidden = true;
        card.hidden = true; card.replaceChildren(); footer.replaceChildren();
        bottom.replaceChildren();
        return cardScope.signal;
      }
      function question(ticket, cs, count) {
        card.hidden = false;
        markdown(card, ticket.question, cs);
        const answer = el("div", "fc-answer"), actions = el("div", "fc-actions"), error = el("p", "fc-error");
        error.setAttribute("role", "alert");
        card.append(answer); footer.append(actions, error);
        if (count !== undefined) bottom.append(el("p", "fc-review-remaining", count));
        return { answer, actions, error };
      }
      function control(parent, label, action, cs, hint, options = {}) {
        const wrapper = el("div", "fc-rating"); parent.append(wrapper);
        const handle = button(wrapper, label, action, cs, options);
        wrapper.append(el("span", "fc-shortcut", hint));
        return handle;
      }
      function nextPractice() {
        if (content.signal.aborted) return;
        // Capture this presentation's cue so an overlapping stale control cannot
        // reveal consumed material or advance the shared queue a second time.
        const cs = reset(), index = practiceIndex, cue = practiceCards[index];
        if (!cue) { footer.append(el("p", "fc-review-meta", "Practice complete.")); return; }
        const remaining = practiceCards.length - index - 1;
        const { answer, actions } = question(cue, cs, `${remaining} ${remaining === 1 ? 'card' : 'cards'} remaining`);
        let revealButton;
        revealAction = () => {
          if (revealed || cs.aborted || index !== practiceIndex) return;
          focusOwned(); revealed = true;
          title.textContent = cue.propositionName; title.hidden = false;
          markdown(answer, cue.answer, cs);
          revealButton.dispose(); actions.replaceChildren();
          advanceAction = () => {
            if (cs.aborted || !revealed || index !== practiceIndex) return;
            focusOwned(); practiceIndex++; nextPractice();
          };
          control(actions, "Next", () => advanceAction?.(), cs, "Space", { variant: "outline" });
        };
        revealButton = control(actions, "Reveal answer", () => revealAction?.(), cs, "Space", { variant: "outline" });
      }
      const retry = (parent, cs) => button(parent, "Retry next card", nextReview, cs);
      async function nextReview() {
        if (content.signal.aborted) return;
        const pending = reset();
        footer.append(el("p", "fc-review-meta", "Loading next card…"));
        try {
          const result = await ctx.call("next-review", scope);
          if (pending.aborted) return;
          const cs = reset();
          if (!result.ticket) {
            footer.append(el("p", "fc-review-meta", result.nextDue ? `No cards ready. Next due ${new Date(result.nextDue).toLocaleString()}.` : "No cards due in this selection."));
            if (result.nextDue) {
              const arm = () => {
                if (cs.aborted) return;
                const delay = result.nextDue - Date.now();
                timer = setTimeout(() => { timer = null; if (cs.aborted) return; if (delay > 2147483647) arm(); else void nextReview(); }, Math.min(2147483647, Math.max(100, delay)));
              };
              arm();
            }
            return;
          }
          const ticket = result.ticket;
          const { answer, actions, error } = question(ticket, cs, result.remaining === undefined ? undefined : `${result.remaining} ready`);
          let revealButton, retryButton, revealBusy = false, ratingBusy = false;
          const requests = new Map();
          const failed = cause => {
            if (cs.aborted) return;
            error.textContent = message(cause);
            if (!retryButton) retryButton = retry(footer, cs);
          };
          revealAction = async () => {
            if (revealBusy || revealed || cs.aborted) return;
            focusOwned();
            revealBusy = true; revealButton.update({ disabled: true });
            try {
              const result = await ctx.call("reveal-review", { ticketId: ticket.id });
              if (cs.aborted) return;
              revealed = true; error.textContent = "";
              title.textContent = ticket.propositionName; title.hidden = false;
              markdown(answer, result.answer, cs);
              focusOwned();
              revealButton.dispose(); actions.replaceChildren();
              const ratingButtons = [];
              rateAction = async rating => {
                if (ratingBusy || cs.aborted) return;
                focusOwned();
                ratingBusy = true;
                ratingButtons.forEach(handle => handle.update({ disabled: true }));
                if (!requests.has(rating)) requests.set(rating, crypto.randomUUID());
                let accepted = false;
                try {
                  // Do not cancel accepted work when the view closes. A transport
                  // retry of the same rating uses the exact same request identity.
                  await ctx.call("rate-review", { ticketId: ticket.id, rating, requestId: requests.get(rating) });
                  accepted = true;
                } catch (cause) {
                  failed(cause);
                  return;
                } finally {
                  ratingBusy = false;
                  if (!cs.aborted && !accepted) ratingButtons.forEach(handle => handle.update({ disabled: false }));
                }
                // Refresh is independent of whether this surface still exists.
                try { void Promise.resolve(onRated?.()).catch(() => {}); } catch { /* A refresh cannot undo an accepted grade. */ }
                if (!cs.aborted) await nextReview();
              };
              ratings.forEach((label, index) => ratingButtons.push(control(actions, `${label} · ${interval(result.intervals[index + 1])}`, () => rateAction?.(index + 1), cs, String(index + 1), ratingOptions(label))));
            } catch (cause) { failed(cause); }
            finally {
              revealBusy = false;
              if (!cs.aborted && !revealed) {
                revealButton.update({ disabled: false });
              }
            }
          };
          revealButton = control(actions, "Reveal answer", () => revealAction?.(), cs, "Space", { variant: "outline" });
        } catch (cause) {
          if (pending.aborted) return;
          const cs = reset();
          const error = el("p", "fc-error", message(cause)); error.setAttribute("role", "alert"); footer.append(error);
          retry(footer, cs);
        }
      }
      const keydown = event => {
        const target = event.target;
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || target?.closest?.("input,textarea,select,a,[contenteditable]:not([contenteditable=false])")) return;
        const space = event.code === "Space" || event.key === " ";
        // No Space chord may activate our scheduled rating controls, including
        // modified or repeated events. Editors and IME retain their own keys.
        if (!practice && revealed && space && target?.closest?.(".fc-rating")) { event.preventDefault(); return; }
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        // Unmodified scheduled Space reveals only, never rates.
        if (!practice && revealed && space) { event.preventDefault(); return; }
        if (event.repeat || target?.closest?.("button")) return;
        if (space) {
          event.preventDefault();
          if (!revealed) void revealAction?.();
          else if (practice) advanceAction?.();
        } else if (!practice && revealed && /^[1-4]$/.test(event.key)) {
          event.preventDefault(); void rateAction?.(Number(event.key));
        }
      };
      root.addEventListener("keydown", keydown);
      content.signal.addEventListener("abort", () => root.removeEventListener("keydown", keydown), { once: true });
      if (practice) nextPractice(); else void nextReview();
      return () => content.abort();
    };
    try {
      // Capture the active page now, never after awaiting a review RPC. Content
      // can mount either during this call or later; it owns starting the request.
      handle = ctx.ui.openSurface({ title: practice ? "Flashcard practice" : "Flashcard review", background: "dimmed", content: mount, onClose: close }, { signal: session.signal });
      if (closed) handle.dispose();
    } catch (cause) { close(); throw cause; }
  }
  return { open: scope => present(scope), openPractice: cards => present(undefined, cards), dispose };
}
