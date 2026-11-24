export function activate(ctx) {
	ctx.registerView({ id: "workbench", name: "Agent example", mount(container, signal) {
		let alive = !signal.aborted, selected = null, refreshing = false, refreshAgain = false;
		let model, thinkingLevel, draft = "", current = null, sending = false, composer;
		const onAbort = () => { alive = false; };
		signal.addEventListener("abort", onAbort, { once: true });
		container.classList.add("plugin-agent-example");
		const element = (tag, text, parent = container) => {
			const node = document.createElement(tag);
			if (text !== undefined) node.textContent = text;
			parent.append(node);
			return node;
		};
		element("h1", "Managed agent example");
		element("p", "Developer example. Model calls use your configured connections and may incur cost. Navigate away and return to observe an ongoing run.");
		const error = element("p", ""); error.setAttribute("role", "alert");
		const controls = element("div"); controls.className = "plugin-agent-example-native";
		const create = element("button", "New conversation", controls);
		const sessionSelect = element("select", undefined, controls); sessionSelect.setAttribute("aria-label", "Conversation");
		const status = element("p", "Loading…");
		const transcript = element("pre", "");
		const pending = element("div"); pending.className = "plugin-agent-example-native";
		element("p", "Model and thinking choices apply to new conversations. Nothing runs until you send a task.");
		const composerContainer = element("div");
		const background = element("button", "Run as background task"); background.type = "button"; background.className = "plugin-agent-example-native";
		const guarded = (fn) => async (...args) => {
			error.textContent = "";
			if (!alive) return;
			try { await fn(...args); } catch (e) { if (alive) error.textContent = e instanceof Error ? e.message : String(e); }
		};
		const composerProps = () => ({
			composer: {
				value: draft,
				onChange: (value) => { draft = value; syncComposer(); },
				onSend: () => submit("user"),
				busy: sending || current?.status === "running",
				onStop: guarded(async () => { if (selected) { await ctx.call("abort", { id: selected }); await refresh(); } }),
				canSend: !!selected && !!draft.trim() && !sending && current?.status !== "running" && !current?.pending.length,
				placeholder: "Write a task. Try asking the agent to ask you a question, or save a note.",
			},
			model: { value: model, onChange: (value) => { model = value; thinkingLevel = undefined; syncComposer(); } },
			thinking: { model, value: thinkingLevel, onChange: (value) => { thinkingLevel = value; syncComposer(); } },
			dictation: { onTranscript: (text) => { draft += (draft ? " " : "") + text; syncComposer(); } },
		});
		const syncComposer = () => {
			if (!alive) return;
			const props = composerProps();
			composer?.update(props);
			background.disabled = !props.composer.canSend;
		};
		const show = (snapshot) => {
			if (!alive || snapshot.id !== selected) return;
			status.textContent = snapshot.status + (snapshot.error ? ": " + snapshot.error : "");
			const describe = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.type === "text" ? part.text : part.type === "toolCall" ? "[" + part.name + "]" : "[" + part.type + "]").join("\n");
			transcript.textContent = [...snapshot.messages, ...(snapshot.partial ? [snapshot.partial] : [])].map((m) => m.role + ": " + describe(m)).join("\n\n");
			current = snapshot;
			syncComposer();
			// Pending inputs do not stream: retain typed answers during unrelated updates.
			const key = JSON.stringify(snapshot.pending.map((p) => p.toolCallId));
			if (pending.dataset.calls === key) return;
			pending.dataset.calls = key;
			pending.replaceChildren();
			for (const call of snapshot.pending) {
				const answerForm = element("form", undefined, pending);
				element("p", call.input?.question ?? call.toolName, answerForm);
				const answer = element("input", undefined, answerForm); answer.required = true; answer.setAttribute("aria-label", "Answer");
				const submit = element("button", "Answer", answerForm); submit.type = "submit";
				answerForm.onsubmit = (event) => {
					event.preventDefault();
					void guarded(async () => {
						submit.disabled = true;
						try { show(await ctx.call("answer", { id: selected, toolCallId: call.toolCallId, answer: answer.value, requestId: crypto.randomUUID() })); }
						finally { if (alive) submit.disabled = false; }
					})();
				};
			}
		};
		const refresh = guarded(async () => {
			if (!selected || !alive) return;
			if (refreshing) { refreshAgain = true; return; }
			refreshing = true;
			try {
				do {
					refreshAgain = false;
					const id = selected;
					const snapshot = await ctx.call("get", { id });
					if (id === selected) show(snapshot);
				} while (alive && refreshAgain);
			} finally { refreshing = false; }
		});
		const loadSessions = async (preferred) => {
			const sessions = await ctx.call("list");
			if (!alive) return;
			sessionSelect.replaceChildren();
			for (const session of sessions) {
				const option = element("option", session.id.slice(0, 8) + " · " + session.status, sessionSelect); option.value = session.id;
			}
			selected = preferred ?? selected ?? sessions.at(-1)?.id ?? null;
			if (selected) { sessionSelect.value = selected; await refresh(); }
			else { current = null; status.textContent = "Choose a model and create a conversation."; syncComposer(); }
		};
		create.onclick = guarded(async () => {
			if (!model) throw new Error("Choose a configured model first");
			const snapshot = await ctx.call("create", { model: { ...model, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) } });
			await loadSessions(snapshot.id);
		});
		sessionSelect.onchange = () => { selected = sessionSelect.value; void refresh(); };
		const submit = guarded(async (purpose) => {
			if (!composerProps().composer.canSend) return;
			const id = selected, text = draft;
			sending = true; syncComposer();
			try {
				const snapshot = await ctx.call("send", { id, text, purpose, requestId: crypto.randomUUID() });
				if (alive && selected === id) { if (draft === text) draft = ""; show(snapshot); }
			} finally { sending = false; syncComposer(); }
		});
		composer = ctx.ui.mountStandardComposer(composerContainer, composerProps(), { signal });
		syncComposer();
		background.onclick = () => void submit("background");
		const offNotification = ctx.onNotification((event) => { if (event.topic === "agents-changed") void refresh(); });
		const offResync = ctx.onResync(() => void guarded(() => loadSessions())());
		void guarded(() => loadSessions())();
		return () => { alive = false; signal.removeEventListener("abort", onAbort); composer.dispose(); offNotification(); offResync(); container.replaceChildren(); container.classList.remove("plugin-agent-example"); };
	} });
	ctx.registerAction({ id: "open", name: "Open agent example", run: () => ctx.app.openView("workbench") });
	ctx.placeAction({ id: "sidebar-open", actionId: "open", location: "sidebar" });
	ctx.placeAction({ id: "graph-open", actionId: "open", location: "graph" });
}
