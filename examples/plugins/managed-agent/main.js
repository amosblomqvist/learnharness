export function activate(ctx) {
	ctx.registerView({ id: "workbench", name: "Agent example", mount(container) {
		let alive = true, selected = null, refreshing = false, refreshAgain = false;
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
		const controls = element("div");
		const modelSelect = element("select", undefined, controls); modelSelect.setAttribute("aria-label", "Model");
		const create = element("button", "New conversation", controls);
		const sessionSelect = element("select", undefined, controls); sessionSelect.setAttribute("aria-label", "Conversation");
		const status = element("p", "Loading…");
		const transcript = element("pre", "");
		const pending = element("div");
		const form = element("form");
		const input = element("textarea", undefined, form); input.setAttribute("aria-label", "Explicit task or message");
		input.placeholder = "Write a task. Try asking the agent to ask you a question, or save a note.";
		const send = element("button", "Send", form); send.type = "submit";
		const background = element("button", "Run as background task", form); background.type = "button";
		const abort = element("button", "Stop run", form); abort.type = "button";
		const guarded = (fn) => async (...args) => {
			error.textContent = "";
			try { await fn(...args); } catch (e) { if (alive) error.textContent = e instanceof Error ? e.message : String(e); }
		};
		const show = (snapshot) => {
			if (!alive || snapshot.id !== selected) return;
			status.textContent = snapshot.status + (snapshot.error ? ": " + snapshot.error : "");
			const describe = (message) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.type === "text" ? part.text : part.type === "toolCall" ? "[" + part.name + "]" : "[" + part.type + "]").join("\n");
			transcript.textContent = [...snapshot.messages, ...(snapshot.partial ? [snapshot.partial] : [])].map((m) => m.role + ": " + describe(m)).join("\n\n");
			const busy = snapshot.status === "running";
			send.disabled = background.disabled = busy || snapshot.pending.length > 0;
			abort.disabled = !busy;
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
			else { status.textContent = "Choose a model and create a conversation."; send.disabled = background.disabled = abort.disabled = true; }
		};
		create.onclick = guarded(async () => {
			if (!modelSelect.value) throw new Error("Configure a provider/model in LearnHarness first");
			const model = JSON.parse(modelSelect.value);
			const snapshot = await ctx.call("create", { model });
			await loadSessions(snapshot.id);
		});
		sessionSelect.onchange = () => { selected = sessionSelect.value; void refresh(); };
		const submit = guarded(async (purpose) => {
			if (!selected || !input.value.trim()) return;
			const text = input.value;
			const snapshot = await ctx.call("send", { id: selected, text, purpose, requestId: crypto.randomUUID() });
			if (alive) { input.value = ""; show(snapshot); }
		});
		form.onsubmit = (event) => { event.preventDefault(); void submit("user"); };
		background.onclick = () => void submit("background");
		abort.onclick = guarded(async () => { await ctx.call("abort", { id: selected }); await refresh(); });
		const offNotification = ctx.onNotification((event) => { if (event.topic === "agents-changed") void refresh(); });
		const offResync = ctx.onResync(() => void guarded(() => loadSessions())());
		void guarded(async () => {
			const catalog = await ctx.call("catalog");
			if (!alive) return;
			for (const model of catalog.models) {
				const option = element("option", model.provider + " · " + model.name, modelSelect);
				option.value = JSON.stringify({ provider: model.provider, id: model.id });
			}
			await loadSessions();
		})();
		return () => { alive = false; offNotification(); offResync(); container.replaceChildren(); container.classList.remove("plugin-agent-example"); };
	} });
}
