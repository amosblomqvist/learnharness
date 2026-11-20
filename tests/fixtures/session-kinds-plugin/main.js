// Test-only fixture (stage C): shows the notebook record on home. The plugin
// owns everything inside the container; the host owns the frame around it.
export function activate(ctx) {
	ctx.registerRecordView({
		recordKind: "notebook",
		mount(container, signal) {
			const body = document.createElement("div");
			body.dataset.testid = "fixture-notebook-view";
			body.textContent = "Fixture notebook";
			container.append(body);
			signal.addEventListener("abort", () => body.remove(), { once: true });
		},
	});
}
