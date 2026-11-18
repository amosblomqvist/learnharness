const paragraph = (container, text) => {
  const element = container.ownerDocument.createElement("p");
  element.textContent = text;
  container.append(element);
  return element;
};

export function activate(ctx) {
  ctx.registerCodeBlock({
    language: "plugin-note",
    mount(container, block) {
      const heading = container.ownerDocument.createElement("strong");
      heading.textContent = block.incomplete ? "Plugin note (streaming)" : "Plugin note";
      const source = container.ownerDocument.createElement("pre");
      source.textContent = block.source;
      container.append(heading, source);
      return () => container.replaceChildren();
    },
  });
  ctx.registerToolRenderer({
    toolName: "teaching_extension_echo",
    mount(container, tool) {
      const heading = container.ownerDocument.createElement("strong");
      heading.textContent = "Teaching extension echo";
      container.append(heading);
      if (tool.state === "output-error") paragraph(container, tool.errorText || "Tool failed");
      else if (tool.state === "output-available") {
        const output = tool.output;
        paragraph(container, output && typeof output.text === "string" ? output.text : "No echo payload");
      } else paragraph(container, "Tool call has not produced a result yet.");
      return () => container.replaceChildren();
    },
  });
  ctx.registerToolRenderer({
    toolName: "teaching_extension_note",
    backgroundPresentation: "plain",
    mount(container, tool) {
      const heading = container.ownerDocument.createElement("strong");
      heading.textContent = tool.background ? "Example note worker result" : "Example note worker dispatch";
      container.append(heading);
      if (tool.state === "output-error") paragraph(container, tool.errorText || "Worker failed");
      else if (tool.background) paragraph(container, tool.output?.note || "No note payload");
      else if (tool.state === "output-available") paragraph(container, "Dispatched. The result will arrive separately; this acknowledgement does not mean the worker has completed.");
      else paragraph(container, "Preparing worker dispatch.");
      return () => container.replaceChildren();
    },
  });
  // Custom settings content is the escape hatch for explanatory/plugin-owned DOM.
  // No schema rows: this fixture has no configurable behavior or navigation chrome.
  ctx.registerSettings((container, _signal) => {
    paragraph(container, "Ask a teacher or practice session to try the teaching-extension example. It adds an echo tool and plugin-note fenced-block rendering. Explicitly request the background-worker example to generate a short note using your cheap model slot; that request may incur cost. It has no automatic runs, independent view, configurable settings or learner-data writes.");
    return () => container.replaceChildren();
  });
}
