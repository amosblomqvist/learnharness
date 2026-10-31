export function activate(context) {
	context.registerView({
		id: "hello",
		name: "Hello plugin",
		mount(container) {
			const heading = document.createElement("h1");
			heading.textContent = "Hello from an external plugin";
			const paragraph = document.createElement("p");
			paragraph.textContent = "This view belongs to the plugin. Closing it does not disable the plugin.";
			container.append(heading, paragraph);
			return () => container.replaceChildren();
		},
	});
	context.registerAction({ id: "open", name: "Open hello view", run: () => context.app.openView("hello") });
	context.registerSettings((container) => {
		const paragraph = document.createElement("p");
		paragraph.textContent = "This example has no settings or backend.";
		container.append(paragraph);
		return () => container.replaceChildren();
	});
}
