export function activate(context) {
	context.registerView({
		id: "hello",
		name: "Hello plugin",
		mount(container, signal) {
			const heading = document.createElement("h1");
			heading.textContent = "Hello from an external plugin";
			const paragraph = document.createElement("p");
			paragraph.textContent = "This view belongs to the plugin. Closing it does not disable the plugin.";
			const button = document.createElement("div");
			container.append(heading, paragraph, button);
			const widget = context.ui.mountButton(button, {
				label: "Say hello",
				onClick: () => {
					context.ui.openDialog({
						title: "Hello plugin",
						content: (content) => {
							const message = document.createElement("p");
							message.textContent = "Plugin content, standard host dialog.";
							content.append(message);
						},
					}, { signal });
				},
			}, { signal });
			return () => { widget.dispose(); container.replaceChildren(); };
		},
	});
	context.registerAction({ id: "open", name: "Open hello view", run: () => context.app.openView("hello") });
	// Registering a view or action alone never adds navigation chrome.
	context.placeAction({ id: "sidebar-open", actionId: "open", location: "sidebar" });
	context.placeAction({ id: "graph-open", actionId: "open", location: "graph" });
	context.placeAction({ id: "session-open", actionId: "open", location: "top-bar", sessions: ["teaching", "practice"] });
	context.registerSettings((container, _signal) => {
		const paragraph = document.createElement("p");
		paragraph.textContent = "This example has no settings or backend.";
		container.append(paragraph);
		return () => container.replaceChildren();
	});
}
