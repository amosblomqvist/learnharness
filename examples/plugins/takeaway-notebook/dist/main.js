export function activate(ctx) {
  ctx.registerQuestionRenderer({
    id: "teach-back",
    supportedContractVersions: [1],
    mountAnswerEditor(container, props) {
      const input = container.ownerDocument.createElement("textarea");
      input.setAttribute("aria-label", "Your teach-back");
      input.placeholder = "Explain it in one sentence…";
      input.className = "lh-notebook-answer";
      input.maxLength = 600;
      container.append(input);
      const publish = () => props.onChange(input.value.trim()
        ? { status: "ready", value: input.value }
        : input.value ? { status: "unready", value: input.value } : { status: "empty" });
      input.addEventListener("input", publish);
      const update = ({ answer, active }) => {
        const text = answer.status === "empty" ? "" : String(answer.value ?? "");
        if (input.value !== text) input.value = text;
        input.readOnly = !active;
      };
      update(props);
      return {
        update,
        focus: () => input.focus(),
        dispose: () => { input.removeEventListener("input", publish); input.remove(); },
      };
    },
  });

  ctx.registerRecordView({
    recordKind: "notebook",
    mount(container, signal) {
      const root = container.ownerDocument.createElement("section");
      root.className = "lh-notebook-view";
      container.append(root);
      function add(parent, tag, text) {
        const element = root.ownerDocument.createElement(tag);
        element.textContent = text;
        parent.append(element);
        return element;
      }
      add(root, "h2", "Takeaway Notebook");
      const list = add(root, "div", "Loading takeaways…");
      let read = 0;
      async function refresh() {
        if (signal.aborted) return;
        const ticket = ++read;
        try {
          const groups = await ctx.call("list", null);
          if (signal.aborted || ticket !== read) return;
          list.replaceChildren();
          if (!groups.length) add(list, "p", "No takeaways yet. Start a Takeaway lesson below.");
          for (const group of groups) {
            const section = add(list, "section", "");
            add(section, "h3", group.title);
            const entries = add(section, "ul", "");
            for (const text of group.entries) add(entries, "li", text);
          }
        } catch {
          if (!signal.aborted && ticket === read) list.textContent = "Could not read the notebook.";
        }
      }
      const offChange = ctx.onNotification(({ topic }) => { if (topic === "notebook-changed") void refresh(); });
      const offResync = ctx.onResync(refresh);
      const offApp = ctx.onAppEvent(({ type }) => { if (type === "chats-changed") void refresh(); });
      void refresh();
      return () => { offChange(); offResync(); offApp(); root.remove(); };
    },
  });
}
