/** Off-network external-plugin proof for the packaged server smoke. The package
 * is created AFTER the build, outside the source/standalone trees. No provider
 * credentials, real learning data, or source-tree imports are involved. */
import * as fs from "node:fs";
import * as path from "node:path";

export const PLUGIN_KNOWLEDGE_FIXTURE = Object.freeze({
	sourceId: "src_plugin_knowledge_smoke", chainId: "arg_plugin_knowledge_smoke",
	premiseId: "n_plugin_knowledge_premise", conclusionId: "n_plugin_knowledge_conclusion",
	sourceLabel: "Plugin knowledge proof",
});

export const PLUGIN_PICKER_SETTINGS_FIXTURE = Object.freeze({ id: "native-smoke-picker-settings", name: "Picker settings proof" });
export const PLUGIN_QUESTION_FIXTURE = Object.freeze({
	chatId: "chat_plugin_question_smoke", title: "Plugin question proof", model: "question-fixture", nodeId: "smoke-question-node",
	predictTool: "native_smoke_predict", checkTool: "native_smoke_check", referenceMarker: "PRIVATE_QUESTION_REFERENCE_7f13",
	predictPrompt: "QUESTION_SMOKE_PREDICT", checkPrompt: "QUESTION_SMOKE_CHECK", review: "Offline teacher review received the exact learner answer and separate host thinking. No grading hook ran.",
});

export const PLUGIN_SESSION_FIXTURE = Object.freeze({
	chatId: "chat_plugin_session_smoke", practiceId: "chat_plugin_session_practice_smoke",
	title: "Session extension proof", practiceTitle: "Session image thinking proof", model: "session-fixture",
	questionPrompt: "SESSION_SMOKE_CHECK", practicePrompt: "SESSION_SMOKE_PROBLEM", tool: "native_smoke_session_check", typeId: "smoke-session-check",
	codeSuffix: "\n```javascript\nconst verbatim = \"<canvas> & image\";\n```\n",
	pathText: "./fixture-attached.png",
});

export function createPluginSmokeFixture(home) {
	const pluginRoot = path.join(home, "data", "plugins", "native-smoke");
	const directory = path.join(pluginRoot, "dist");
	fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
	fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({
		apiVersion: 1, id: "native-smoke", name: "Runtime proof", version: "1.0.0", minAppVersion: "0.3.7", main: "main.js", backend: "backend.cjs",
	}));
	fs.writeFileSync(path.join(directory, "backend.cjs"), `
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
exports.activate = async (ctx) => {
  // An activation-owned LOOPBACK provider, never a real account or model.
  // Hold the protocol open without returning any tokens or terminal response.
  const held = new Set();
  const sockets = new Set();
  const counts = { requests: 0, active: 0, peak: 0, aborted: 0, completed: 0, models: 0 };
  const requests = [];
  const questionFixture = ${JSON.stringify(PLUGIN_QUESTION_FIXTURE)};
  const sessionFixture = ${JSON.stringify(PLUGIN_SESSION_FIXTURE)};
  const sessionEvents = [], sessionRequests = [], sessionResponses = new Map();
  let sessionFailNext = false;
  ctx.handle("session-fail-next", () => { sessionFailNext = true; return { armed: true }; });
  ctx.handle("session-event", event => { sessionEvents.push(event); return { recorded: sessionEvents.length }; });
  ctx.handle("session-status", () => ({ events: sessionEvents.slice(), requests: sessionRequests.slice(), pending: sessionResponses.size }));
  ctx.handle("session-release", () => {
    if (sessionResponses.size !== 1) throw new Error("Expected exactly one pending session-fixture response");
    const [response, finish] = sessionResponses.entries().next().value;
    sessionResponses.delete(response); finish(); return { released: true };
  });
  // Native questions share only the listener, never admission counters/held responses.
  const questionCounts = { requests: 0, poses: 0, reviews: 0, completed: 0 };
  const questionRequests = [];
  const questionResponses = new Map();
  const taskIds = [];
  let mockBase;
  let cleanupPromise;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      counts.models++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: ["admission-fixture", questionFixture.model, sessionFixture.model].map(id => ({ id, object: "model", owned_by: "loopback-fixture" })) }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404); res.end(); return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.once("end", () => {
      const input = JSON.parse(body);
      if (input.model === sessionFixture.model) {
        // Capture ACTUAL OpenAI-compatible adapter wire content, including
        // image_url blocks. Browser assertions decode bytes, not UI markers.
        sessionRequests.push({ model: input.model, stream: input.stream,
          keylessPlaceholder: req.headers.authorization === "Bearer not-needed",
          messages: input.messages, tools: input.tools?.map(tool => tool.function?.name) });
        if (sessionFailNext) {
          sessionFailNext = false;
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Session fixture deliberate model failure", type: "fixture_error", code: "fixture_failure" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = (delta, finish_reason = null) => res.write("data: " + JSON.stringify({
          id: "chatcmpl-session-" + sessionRequests.length, object: "chat.completion.chunk", created: 1, model: sessionFixture.model,
          choices: [{ index: 0, delta, finish_reason }]
        }) + "\\n\\n");
        chunk({ role: "assistant" }); res.flushHeaders();
        sessionResponses.set(res, () => {
          const last = input.messages.at(-1);
          const pose = last?.role === "user" && JSON.stringify(last.content).includes(sessionFixture.questionPrompt);
          if (last?.role === "user" && JSON.stringify(last.content).includes(sessionFixture.practicePrompt)) {
            chunk({ tool_calls: [{ index: 0, id: "session_problem_live", type: "function", function: { name: "problem",
              arguments: JSON.stringify({ statement: "Explain your offline canvas reasoning.", mode: "composition", modelSolution: "A valid offline drawing explanation." }) } }] });
            chunk({}, "tool_calls");
          } else if (pose) {
            chunk({ tool_calls: [{ index: 0, id: "session_check_live", type: "function", function: {
              name: sessionFixture.tool, arguments: JSON.stringify({ type: "check", nodeId: questionFixture.nodeId,
                question: "Read, then provide the session extension code answer.", payload: { prompt: "Preserve the code verbatim.", referenceMarker: questionFixture.referenceMarker } })
            } }] }); chunk({}, "tool_calls");
          } else { chunk({ content: "Session fixture native continuation." }); chunk({}, "stop"); }
          res.end("data: [DONE]\\n\\n");
        });
        res.once("close", () => sessionResponses.delete(res));
        return;
      }
      if (input.model === questionFixture.model) {
        questionCounts.requests++;
        const lastUser = input.messages.filter(message => message.role === "user").at(-1);
        const last = input.messages.at(-1);
        const review = last?.role === "tool" && last.tool_call_id === "question_predict_good";
        const check = !review && JSON.stringify(lastUser?.content).includes(questionFixture.checkPrompt);
        questionRequests.push({ model: input.model, stream: input.stream, authenticated: Boolean(req.headers.authorization), keylessPlaceholder: req.headers.authorization === "Bearer not-needed", tools: input.tools?.map(tool => tool.function?.name),
          phase: review ? "review" : check ? "check" : "predict", reviewContent: review ? last.content : undefined,
          modelHistoryHasQuestionMetadata: JSON.stringify(input.messages).includes('"lhQuestions"') });
        res.once("finish", () => { questionCounts.completed++; });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = (delta, finish_reason = null) => res.write("data: " + JSON.stringify({
          id: "chatcmpl-question-" + questionCounts.requests, object: "chat.completion.chunk", created: 1, model: questionFixture.model,
          choices: [{ index: 0, delta, finish_reason }]
        }) + "\\n\\n");
        // A public fixture RPC releases actual protocol bytes only after the
        // browser has attached to the native event stream. No result injection.
        chunk({ role: "assistant" });
        res.flushHeaders();
        questionResponses.set(res, () => {
        if (review) {
          questionCounts.reviews++;
          chunk({ role: "assistant", content: questionFixture.review }); chunk({}, "stop");
        } else {
          questionCounts.poses++;
          const tool = check ? questionFixture.checkTool : questionFixture.predictTool;
          const args = { type: check ? "check" : "predict", nodeId: questionFixture.nodeId,
            question: check ? "Read before revealing the offline check." : "Predict the exact offline fixture text.",
            payload: { prompt: "Use a plain text editor; whitespace is significant.", referenceMarker: questionFixture.referenceMarker } };
          const calls = check ? [{ id: "question_check_good", arguments: args }] : [
            { id: "question_predict_bad", arguments: { ...args, question: " " } },
            { id: "question_predict_good", arguments: args }
          ];
          chunk({ role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: tool, arguments: JSON.stringify(call.arguments) } })) });
          chunk({}, "tool_calls");
        }
        res.end("data: [DONE]\\n\\n");
        });
        res.once("close", () => questionResponses.delete(res));
        return;
      }
      if (input.model !== "admission-fixture") { res.writeHead(400); res.end("Unexpected fixture model"); return; }
      requests.push({ model: input.model, stream: input.stream, authenticated: Boolean(req.headers.authorization) });
      counts.requests++;
      held.add(res);
      counts.active = held.size;
      counts.peak = Math.max(counts.peak, counts.active);
      res.once("finish", () => { counts.completed++; });
      res.once("close", () => {
        held.delete(res);
        counts.active = held.size;
        if (!res.writableFinished) counts.aborted++;
      });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders();
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  ctx.cleanup(() => cleanupPromise ??= (async () => {
    // Retained handles only: destroy held responses and keep-alive sockets,
    // then await the one close. No process/name killing or leaked listeners.
    for (const response of held) response.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.removeAllListeners();
    fs.writeFileSync(path.join(ctx.dataDirectory, "disabled.txt"), "cleaned");
  })());
  await new Promise((resolve, reject) => {
    const failed = error => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(0, "127.0.0.1");
  });
  mockBase = "http://127.0.0.1:" + server.address().port + "/v1";
  ctx.workers.register({
    id: "admission-proof",
    instructions: "Offline admission fixture. Do not use external services. Submit the requested result.",
    resultSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
  });
  const snapshot = () => ({
    mockBase, counts: { ...counts }, requests: requests.slice(),
    tasks: taskIds.map(id => { const task = ctx.workers.get(id); return { id: task.id, definitionId: task.definitionId, status: task.status, turns: task.turns, error: task.error }; })
  });
  ctx.handle("admission-status", snapshot);
  ctx.handle("question-status", () => ({ counts: { ...questionCounts }, requests: questionRequests.slice() }));
  ctx.handle("question-release", () => {
    if (questionResponses.size !== 1) throw new Error("Expected exactly one pending question-model protocol response");
    const [response, finish] = questionResponses.entries().next().value;
    questionResponses.delete(response); finish(); return { released: true };
  });
  for (const [id, toolName, showThinking] of [["smoke-predict", questionFixture.predictTool, true], ["smoke-check", questionFixture.checkTool, false], [sessionFixture.typeId, sessionFixture.tool, true]]) {
    ctx.registerQuestionType({ id, label: "Offline text question", contractVersion: 1, showThinking,
      questionSchema: { type: "object", properties: { prompt: { type: "string" }, referenceMarker: { type: "string" } }, required: ["prompt", "referenceMarker"], additionalProperties: false },
      answerSchema: { type: "string" },
      teach: { toolName, description: "Pose only the explicitly requested offline smoke question at the live fixture node." }
    });
  }
  ctx.handle("admission-start", () => {
    if (taskIds.length) throw new Error("Admission fixture starts exactly one explicit batch per activation");
    for (let index = 0; index < 3; index++) {
      const task = ctx.workers.start("admission-proof", {
        requestId: "admission-proof-" + index, input: { index },
        prompt: "Return the fixture value using submit_result.",
        model: { provider: "custom", id: "admission-fixture" }, purpose: "background", maxTurns: 1
      });
      taskIds.push(task.id);
    }
    return snapshot();
  });
  fs.writeFileSync(path.join(ctx.dataDirectory, "activated.txt"), "native-node");
  ctx.registerInstructions({ agents: ["teacher"], text: "Packaged smoke fixture: no automatic model requests." });
  ctx.registerTools({ agents: ["teacher"], create: () => [{
    name: "native_smoke_echo", label: "Native smoke echo", description: "Offline runtime fixture",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    execute: async (_id, input) => ({ content: [{ type: "text", text: input.value }], details: input })
  }] });
  ctx.handle("proof", (input) => ({ answer: input, node: process.versions.node, data: ctx.dataDirectory, learning: ctx.learning.directory }));
};
`);
	const helper = `
export const message = "External module loaded";
export function mountPickerProof(ctx, container, signal, scope, mountCount) {
  const root = document.createElement("div"); root.dataset.smokePickerScope = scope;
  root.dataset.mountCount = String(mountCount);
  root.dataset.instance = scope + ":" + mountCount;
  root.dataset.signalAborted = String(signal.aborted); root.dataset.cleanupCount = "0";
  signal.addEventListener("abort", () => { root.dataset.signalAborted = "true"; }, { once: true });
  container.append(root);
  const input = document.createElement("input"); input.type = "text";
  input.dataset.smokePickerDraft = scope; input.setAttribute("aria-label", scope + " picker draft"); root.append(input);
  const menuTrigger = document.createElement("button"); menuTrigger.type = "button";
  menuTrigger.dataset.smokePickerMenu = scope; menuTrigger.textContent = "Open owned menu"; root.append(menuTrigger);
  root.dataset.menuCloses = "0";
  menuTrigger.addEventListener("click", () => ctx.ui.openMenu(menuTrigger, {
    label: scope + " owned menu", items: [{ key: "proof", label: "Owned menu item", onSelect() {} }],
    onClose() { root.dataset.menuCloses = String(Number(root.dataset.menuCloses) + 1); }
  }, { signal }));
  const state = document.createElement("p"); state.dataset.smokePickerSelection = scope;
  state.dataset.callbacks = "0"; state.textContent = "[]"; root.append(state);
  let value = [];
  const picker = ctx.ui.mountKnowledgePicker(root, {
    value,
    onChange(ids) {
      value = ids; picker.update({ value }); state.textContent = JSON.stringify(value);
      state.dataset.callbacks = String(Number(state.dataset.callbacks) + 1);
    }
  }, { signal });
  return () => { root.dataset.cleanupCount = String(Number(root.dataset.cleanupCount) + 1); root.remove(); };
}
`;
	fs.writeFileSync(path.join(directory, "assets", "helper.js"), helper);
	const formattedMarkdown = [
		"# Static Markdown proof",
		"Native prose **bold proof** and *italic proof* with `inlineProof`.",
		"Inline math $a^2+b^2=c^2$.",
		"$$\n\\int_0^1 x\\,dx=\\frac12\n$$",
		"| Column | Value |\n| --- | --- |\n| Static table proof | 42 |",
		"> [!IMPORTANT]\n> Static callout proof.",
		"```typescript\nconst staticProof: number = 42;\n```",
		"```mermaid\nflowchart LR\n  staticStart[Static start] --> staticEnd[Static finish]\n```",
		"```smoke-note proof=static\nStatic registered-language fence stays built-in.\n```",
		"![Static image proof](STATIC_IMAGE_URL)",
		"[Ordinary fragment link](#STATIC_ANCHOR)",
	].join("\n\n");
	const updatedDiagram = "# Updated diagram proof\n\n```mermaid\nflowchart LR\n  updatedA[Updated start] --> updatedB[Updated finish]\n```";
	const invalidDiagram = "# Invalid diagram proof\n\n```mermaid\nflowchart LR\n  Static[unterminated\n```";
	fs.writeFileSync(path.join(directory, "assets", "markdown-proof.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24" viewBox="0 0 48 24"><rect width="48" height="24" fill="#64748b"/><circle cx="12" cy="12" r="7" fill="#f8fafc"/></svg>\n');
	fs.writeFileSync(path.join(directory, "assets", "markdown-proof.js"), `
const formattedSource = ${JSON.stringify(formattedMarkdown)};
const updatedDiagram = ${JSON.stringify(updatedDiagram)};
const invalidDiagram = ${JSON.stringify(invalidDiagram)};
export function mountMarkdownProof(ctx, container, signal, scope, mountCount, customMounts) {
  const root = document.createElement("section"); root.dataset.smokeMarkdownScope = scope;
  root.dataset.viewMount = String(mountCount); root.dataset.parentAborted = String(signal.aborted); root.dataset.widgetMounts = "0";
  container.append(root);
  const anchor = document.createElement("span"); anchor.id = "static-markdown-" + scope + "-anchor"; root.append(anchor);
  const controls = document.createElement("div"); root.append(controls);
  const output = document.createElement("div"); output.dataset.smokeMarkdownOutput = scope; root.append(output);
  const sentinel = document.createElement("span"); sentinel.dataset.smokeMarkdownSentinel = scope;
  sentinel.textContent = "Plugin-owned sentinel"; output.append(sentinel);
  let handle, widgetScope, raceTimer, raceObserver;
  const probe = () => { root.dataset.customMounts = String(customMounts()); root.dataset.widgetAborted = String(widgetScope?.signal.aborted ?? false); };
  const mount = () => {
    clearTimeout(raceTimer); raceObserver?.disconnect(); handle?.dispose(); widgetScope?.abort(); widgetScope = new AbortController();
    if (signal.aborted) widgetScope.abort();
    handle = ctx.ui.mountMarkdown(output, { text: "Static plain proof." }, { signal: widgetScope.signal });
    root.dataset.widgetMounts = String(Number(root.dataset.widgetMounts) + 1); probe();
  };
  const formatted = () => formattedSource.replace("STATIC_IMAGE_URL", new URL("./markdown-proof.svg", import.meta.url).href).replace("STATIC_ANCHOR", anchor.id);
  const actions = {
    plain() { handle.update({ text: "Static latest plain proof." }); },
    formatted() { handle.update({ text: formatted() }); },
    diagram() { handle.update({ text: updatedDiagram }); },
    invalid() { handle.update({ text: invalidDiagram }); },
    race() {
      const owner = handle; clearTimeout(raceTimer); raceObserver?.disconnect();
      const retirePending = () => {
        if (!output.querySelector('[aria-busy="true"]')) return;
        raceObserver.disconnect(); raceTimer = setTimeout(() => owner.update({ text: "Static latest plain proof." }), 0);
      };
      raceObserver = new MutationObserver(retirePending); raceObserver.observe(output, { subtree: true, childList: true, attributes: true });
      owner.update({ text: updatedDiagram }); retirePending();
    },
    abort() { clearTimeout(raceTimer); raceObserver?.disconnect(); widgetScope.abort(); handle.update({ text: formatted() }); probe(); },
    dispose() { clearTimeout(raceTimer); raceObserver?.disconnect(); handle.dispose(); handle.dispose(); handle.update({ text: formatted() }); probe(); },
    remount: mount,
    probe,
  };
  for (const [action, run] of Object.entries(actions)) {
    const button = document.createElement("button"); button.type = "button"; button.dataset.smokeMarkdownAction = action;
    button.textContent = "Markdown " + action; button.addEventListener("click", run); controls.append(button);
  }
  const parentAbort = () => { root.dataset.parentAborted = "true"; clearTimeout(raceTimer); raceObserver?.disconnect(); widgetScope?.abort(); probe(); };
  signal.addEventListener("abort", parentAbort, { once: true });
  mount();
  return () => { clearTimeout(raceTimer); raceObserver?.disconnect(); signal.removeEventListener("abort", parentAbort); handle.dispose(); widgetScope.abort(); root.remove(); };
}
`);
	fs.writeFileSync(path.join(directory, "assets", "question-proof.js"), `
// External public-API renderer. No app imports, editor library, or grading hooks.
export function registerQuestionProof(ctx) {
  let mounts = 0;
  for (const id of ["smoke-predict", "smoke-check", "smoke-session-check"]) ctx.registerQuestionRenderer({
    id, supportedContractVersions: [1],
    mountQuestion(container, context) {
      const rich = document.createElement("strong"); rich.dataset.smokeQuestionRich = context.questionId;
      rich.dataset.immutable = String(Object.isFrozen(context) && Object.isFrozen(context.input) && Object.isFrozen(context.input.payload));
      rich.textContent = context.input.question + " " + context.input.payload.prompt; container.append(rich);
      return () => rich.remove();
    },
    mountAnswerEditor(container, props) {
      const textarea = document.createElement("textarea"); textarea.dataset.smokeQuestionEditor = props.questionId;
      textarea.setAttribute("aria-label", "Offline plugin answer"); textarea.rows = 3;
      textarea.dataset.mount = String(++mounts); textarea.dataset.aborted = "false"; textarea.dataset.disposes = "0";
      textarea.dataset.tabs = "0"; textarea.dataset.publishes = "0"; container.append(textarea);
      const apply = ({ answer, active }) => {
        const value = answer.status === "empty" ? "" : answer.value;
        if (textarea.value !== value) textarea.value = value;
        textarea.disabled = !active; textarea.dataset.active = String(active);
      };
      const publish = () => { textarea.dataset.publishes = String(Number(textarea.dataset.publishes) + 1); props.onChange({ status: "ready", value: textarea.value }); };
      textarea.addEventListener("input", publish);
      props.signal.addEventListener("abort", () => { textarea.dataset.aborted = "true"; }, { once: true });
      apply(props);
      return {
        update: apply,
        focus() { textarea.focus(); },
        handleKeyDown(key) {
          if (key !== "Tab") return "pass";
          textarea.setRangeText("\\t", textarea.selectionStart, textarea.selectionEnd, "end");
          textarea.dataset.tabs = String(Number(textarea.dataset.tabs) + 1); publish(); return "handled";
        },
        // Deliberately no appendTranscript: host thinking owns predict speech;
        // revealed thinking-off check must retain a visible disabled microphone.
        dispose() { textarea.dataset.disposes = String(Number(textarea.dataset.disposes) + 1); textarea.remove(); }
      };
    },
    mountAnswered(container, context) {
      const pre = document.createElement("pre"); pre.dataset.smokeQuestionAnswered = context.questionId;
      pre.textContent = context.answer; container.append(pre); return () => pre.remove();
    }
  });
}
`);
	fs.writeFileSync(path.join(directory, "assets", "session-proof.js"), `
// Independent external fixture: PUBLIC ctx only. Attributes below belong only
// to DOM created here; native host DOM is never patched or used as authority.
const fixture = ${JSON.stringify(PLUGIN_SESSION_FIXTURE)};
export function registerSessionProof(ctx) {
  let pending, revision = 0, attempts = 0, accepts = 0, mounts = 0, closes = 0;
  let lastTarget;
  const report = event => ctx.call("session-event", event);
  const state = () => ({ pending: !!pending, revision, attempts, accepts, mounts, closes });
  const png = color => {
    const canvas = document.createElement("canvas"); canvas.width = 12; canvas.height = 8;
    const brush = canvas.getContext("2d"); brush.fillStyle = color; brush.fillRect(0, 0, 12, 8);
    return { type: "image", mimeType: "image/png", data: canvas.toDataURL("image/png").split(",")[1] };
  };
  ctx.registerSubmissionInterceptor({ id: "session-proof", priority: 7,
    hasPendingInput(target) { return !!pending && pending.sessionId === target.sessionId; },
    async intercept(input, context) {
      if (![fixture.chatId, fixture.practiceId].includes(context.sessionId)) return;
      const captured = pending;
      const attempt = ++attempts;
      await report({ event: "intercept", attempt, type: input.type, channels: context.channels,
        input, historyFrozen: Object.isFrozen(context.messages) && context.messages.every(Object.isFrozen),
        inputFrozen: Object.isFrozen(input), surfaceTargetPresent: !!context.surfaceTarget,
        pendingRevision: captured?.revision });
      if (captured?.fail) { captured.fail = false; throw new Error("session fixture fail closed"); }
      if (!captured) return;
      context.onAccepted(async () => {
        accepts++;
        if (pending === captured) { pending = undefined; ctx.refreshSubmissions(); }
        await report({ event: "accepted", attempt, revision: captured.revision, ...state() });
      });
      if (input.type === "text" || input.type === "thinking") return { ...input, content: { ...input.content, images: [captured.answer] } };
      if (input.type === "plugin-question-answer") return { ...input, answer: input.answer + fixture.codeSuffix,
        answerImages: [captured.answer],
        thinking: { ...input.thinking, images: context.channels.includes("thinking") ? [captured.thinking] : [] },
        readingThinking: { ...input.readingThinking, images: context.channels.includes("readingThinking") ? [captured.reading] : [] } };
    }
  });
  const open = context => {
    const target = context.surfaceTarget; lastTarget = target;
    const show = (depth = 0) => {
      let handle;
      handle = ctx.ui.openSurface(target, { title: depth ? "Nested session proof" : "Session extension proof",
        onClose() { closes++; void report({ event: "surface-close", depth, ...state() }); },
        content(container, signal) {
          const root = document.createElement("section"); root.dataset.smokeSessionSurface = String(depth);
          const input = document.createElement("input"); input.setAttribute("aria-label", "Surface draft " + depth); root.append(input);
          const output = document.createElement("pre"); output.dataset.smokeSessionState = "true"; root.append(output);
          container.append(root); mounts++;
          const probe = async () => { output.textContent = JSON.stringify(state()); await report({ event: "probe", depth, ...state() }); };
          const button = (label, action, run) => { const node = document.createElement("button"); node.type = "button";
            node.textContent = label; node.dataset.smokeSessionAction = action; node.onclick = () => { void run(); }; root.append(node); };
          const arm = async fail => {
            pending = { sessionId: context.sessionId, revision: ++revision, fail,
              answer: png("#ef4444"), thinking: png("#22c55e"), reading: png("#3b82f6") };
            ctx.refreshSubmissions();
            await report({ event: "armed", ...state(), answer: pending.answer, thinking: pending.thinking, reading: pending.reading });
            await probe();
          };
          button("Arm canvas images", "arm", () => arm(false));
          button("Arm failing canvas images", "fail", () => arm(true));
          button("Arm model failure with canvas", "model-error", async () => { await ctx.call("session-fail-next"); await arm(false); });
          button("Probe pending input", "probe", probe);
          button("Open nested surface", "nested", () => show(depth + 1));
          button("Close proof surface", "close", () => handle.dispose());
          button("Open global Settings", "settings", () => ctx.app.openSettings());
          void report({ event: "surface-mount", depth, targetPresent: !!target, ...state() });
          void probe();
          return () => { root.remove(); void report({ event: "surface-cleanup", depth, aborted: signal.aborted }); };
        }
      }, { signal: ctx.signal });
      return handle;
    };
    return show();
  };
  // Test stale token using only a legitimately captured public host reference.
  // This existing plugin view control runs after native navigation has expired it.
  return { open, probeStale: async () => {
    let error;
    try { const handle = ctx.ui.openSurface(lastTarget, { title: "Must never mount stale surface", content() { throw new Error("Stale surface mounted"); } }, { signal: ctx.signal }); handle.dispose(); }
    catch (caught) { error = caught.message; }
    await report({ event: "stale-target", error });
  } };
}
`);
	fs.writeFileSync(path.join(directory, "main.js"), `
import { message, mountPickerProof } from "./assets/helper.js";
import { mountMarkdownProof } from "./assets/markdown-proof.js";
import { registerQuestionProof } from "./assets/question-proof.js";
import { registerSessionProof } from "./assets/session-proof.js";
export function activate(ctx) {
  registerQuestionProof(ctx);
  const sessionProof = registerSessionProof(ctx);
  let dialogMounts = 0, markdownViewMounts = 0, markdownDialogMounts = 0, customCodeBlockMounts = 0;
  ctx.registerCodeBlock({ language: "smoke-note", mount(container, block) {
    customCodeBlockMounts++;
    container.dataset.smokeFence = "true"; container.dataset.smokeMeta = block.meta;
    container.textContent = "Rendered fence: " + block.source;
    return () => container.replaceChildren();
  }});
  ctx.registerToolRenderer({ toolName: "native_smoke_echo", backgroundPresentation: "plain", mount(container, tool) {
    container.dataset[tool.background ? "smokeBackground" : "smokeTool"] = "true";
    container.textContent = (tool.background ? "Rendered worker: " : "Rendered tool: ") + tool.output.value;
    return () => container.replaceChildren();
  }});
  ctx.registerAction({ id: "open", name: "Runtime proof", run: context => context.surface === "session" ? sessionProof.open(context) : ctx.app.openView("proof") });
  ctx.placeAction({ id: "open-sidebar", actionId: "open", location: "sidebar" });
  ctx.placeAction({ id: "open-graph", actionId: "open", location: "graph" });
  ctx.placeAction({ id: "open-session", actionId: "open", location: "top-bar", sessions: ["teaching", "practice"] });
  for (let index = 0; index < 32; index++) {
    ctx.placeAction({ id: "rail-" + index, actionId: "open", location: "graph" });
    if (index < 8) {
      ctx.placeAction({ id: "sidebar-" + index, actionId: "open", location: "sidebar" });
      ctx.placeAction({ id: "session-" + index, actionId: "open", location: "top-bar", sessions: ["teaching", "practice"] });
    }
  }
  const row = { key: "proof", label: "Fixture toggle", type: "toggle", value: false, onChange(value) { settings.update({ rows: [{ ...row, value }] }); } };
  const settings = ctx.registerSettings({ rows: [row] });
  ctx.registerView({ id: "proof", name: "Runtime proof", async mount(container, signal) {
    const heading = document.createElement("h1"); heading.textContent = message; container.append(heading);
    const controls = document.createElement("div"); container.append(controls);
    ctx.ui.mountButton(controls, { label: "Probe stale surface target", onClick: () => sessionProof.probeStale() }, { signal });
    const selection = document.createElement("p"); selection.dataset.smokeKnowledgeState = "true";
    selection.dataset.callbacks = "0"; selection.textContent = "[]"; container.append(selection);
    let picked = [];
    const knowledge = ctx.ui.mountKnowledgePicker(controls, {
      value: picked,
      onChange(ids) {
        picked = ids;
        knowledge.update({ value: picked });
        selection.textContent = JSON.stringify(picked);
        selection.dataset.callbacks = String(Number(selection.dataset.callbacks) + 1);
      }
    }, { signal });
    ctx.ui.mountButton(controls, { label: "Open host dialog", title: "Open host dialog", onClick: () => { ctx.ui.openDialog({ title: "Plugin dialog proof", content: (body) => { body.textContent = "Host dialog content"; } }, { signal }); } }, { signal });
    ctx.ui.mountButton(controls, { label: "Open knowledge dialog", title: "Open knowledge dialog", onClick: () => {
      ctx.ui.openDialog({ title: "Picker dialog proof", content: (body, dialogSignal) => mountPickerProof(ctx, body, dialogSignal, "dialog", ++dialogMounts) }, { signal });
    } }, { signal });
    ctx.ui.mountButton(controls, { label: "Open static Markdown dialog", title: "Open static Markdown dialog", onClick: () => {
      ctx.ui.openDialog({ title: "Static Markdown dialog proof", content: (body, dialogSignal) => mountMarkdownProof(ctx, body, dialogSignal, "dialog", ++markdownDialogMounts, () => customCodeBlockMounts) }, { signal });
    } }, { signal });
    let draft = "";
    const composerProps = () => ({ value: draft, onChange(value) { draft = value; widget.update({ composer: composerProps() }); }, onSend() { const sent = document.createElement("p"); sent.dataset.smokeSubmitted = "true"; sent.textContent = draft; container.append(sent); draft = ""; widget.update({ composer: composerProps() }); }, placeholder: "Plugin composer proof" });
    const widget = ctx.ui.mountStandardComposer(controls, { composer: composerProps(), model: { value: undefined, onChange() {} }, thinking: { model: undefined, value: undefined, onChange() {} }, dictation: { onTranscript(text) { draft = (draft + " " + text).trim(); widget.update({ composer: composerProps() }); } } }, { signal });
    const cleanupMarkdown = mountMarkdownProof(ctx, container, signal, "view", ++markdownViewMounts, () => customCodeBlockMounts);
    const result = await ctx.call("proof", "browser-bridge");
    if (ctx.signal.aborted) return;
    const body = document.createElement("p"); body.textContent = result.answer; container.append(body);
    return () => { cleanupMarkdown(); container.replaceChildren(); };
  }});
}
`);
	// Separate frontend-only custom Settings page: preserve native-smoke's
	// existing schema registration/update-handle proof, without host injection.
	const settingsFixture = PLUGIN_PICKER_SETTINGS_FIXTURE;
	const settingsDirectory = path.join(home, "data", "plugins", settingsFixture.id, "dist");
	fs.mkdirSync(path.join(settingsDirectory, "assets"), { recursive: true });
	fs.writeFileSync(path.join(settingsDirectory, "manifest.json"), JSON.stringify({
		apiVersion: 1, id: settingsFixture.id, name: settingsFixture.name,
		version: "1.0.0", minAppVersion: "0.3.7", main: "main.js",
	}));
	fs.writeFileSync(path.join(settingsDirectory, "assets", "helper.js"), helper);
	fs.writeFileSync(path.join(settingsDirectory, "main.js"), `
import { mountPickerProof } from "./assets/helper.js";
export function activate(ctx) {
  let mounts = 0;
  ctx.registerSettings((container, signal) => mountPickerProof(ctx, container, signal, "settings", ++mounts));
}
`);
	fs.mkdirSync(path.join(pluginRoot, "data"), { recursive: true });
	fs.writeFileSync(path.join(pluginRoot, "data", "private.json"), '{"private":true}\n');
	// Seed native history. Admission opens only held LOOPBACK protocol requests;
	// the separate question proof later generates scripted offline native turns.
	// No external provider calls, accounts, or personal learning data are used.
	// Browser proof exercises the SAME shared Markdown/tool surfaces as lessons.
	const chats = path.join(home, "data", "chats");
	fs.mkdirSync(chats, { recursive: true });
	fs.writeFileSync(path.join(chats, "chat_plugin_smoke.json"), JSON.stringify({
		version: 1, id: "chat_plugin_smoke", title: "Plugin transcript proof",
		createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(),
		messages: [
			{ id: "user_smoke", role: "user", content: "Show the stored plugin rendering fixture.", timestamp: 1 },
			{ id: "assistant_smoke", role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
				content: [
					{ type: "text", text: "```smoke-note proof=1\nFence source.\n```" },
					{ type: "toolCall", id: "call_smoke", name: "native_smoke_echo", arguments: { value: "Stored input" } },
				], stopReason: "toolUse", timestamp: 2,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
			{ id: "result_smoke", role: "toolResult", toolCallId: "call_smoke", toolName: "native_smoke_echo",
				content: [{ type: "text", text: "Stored native result" }], details: { value: "Tool detail" }, isError: false, timestamp: 3 },
			{ id: "steer_job_plugin_smoke", role: "custom", customType: "subagent-steer", display: true,
				content: "A stored fixture worker finished; no real model was called.", timestamp: 4,
				details: { jobId: "job_plugin_smoke", kind: "plugin", toolCallId: "call_smoke", result: {
					pluginId: "native-smoke", toolName: "native_smoke_echo", input: { value: "Stored input" },
					outcome: { id: "task_smoke", status: "succeeded", result: { value: "Worker detail" } },
					text: "Stored worker result", data: { value: "Worker detail" },
				} },
			},
		],
	}, null, 2));
	// Only prerequisite teaching truth is seeded. Plugin question authority and
	// answers MUST be minted by real native turns against the loopback provider.
	const questionFixture = PLUGIN_QUESTION_FIXTURE;
	const tree = { nodes: [{ id: questionFixture.nodeId, title: "Offline text node" }], edges: [], version: 1 };
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (id, content) => ({ id, role: "assistant", api: "openai-completions", provider: "custom", model: questionFixture.model, content, stopReason: "toolUse", timestamp: 2, usage });
	const result = (id, toolCallId, toolName, details) => ({ id, role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "Offline prerequisite completed." }], details, isError: false, timestamp: 3 });
	fs.writeFileSync(path.join(chats, questionFixture.chatId + ".json"), JSON.stringify({
		version: 1, id: questionFixture.chatId, title: questionFixture.title, tree,
		createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(),
		settings: { model: { provider: "custom", id: questionFixture.model } },
		messages: [
			{ id: "question_seed_user", role: "user", content: "Offline native question proof.", timestamp: 1 },
			assistant("question_seed_probe", [{ type: "toolCall", id: "question_seed_probe_call", name: "probe_done", arguments: { assessment: { strands: [{ strand: "Text", assessment: "Ready for teaching." }] } } }]),
			result("question_seed_probe_result", "question_seed_probe_call", "probe_done", { ok: true }),
			assistant("question_seed_plan", [{ type: "toolCall", id: "question_seed_plan_call", name: "plan_init", arguments: { mermaid: "graph TD\n  " + questionFixture.nodeId + "[Offline text node]" } }]),
			result("question_seed_plan_result", "question_seed_plan_call", "plan_init", { ok: true, tree }),
			{ ...assistant("question_seed_notes", [{ type: "text", text: Array.from({ length: 80 }, (_, index) => "Offline lesson paragraph " + index + ": preserve whitespace and keep thinking separate.").join("\n\n") }]), stopReason: "stop" },
		],
	}, null, 2));
	// Duplicate only the established ordinary prerequisite teaching history.
	// New pending questions/results are exclusively authored by native turns.
	const session = PLUGIN_SESSION_FIXTURE;
	const bootstrap = JSON.parse(fs.readFileSync(path.join(chats, questionFixture.chatId + ".json"), "utf8"));
	fs.writeFileSync(path.join(chats, session.chatId + ".json"), JSON.stringify({ ...bootstrap,
		id: session.chatId, title: session.title, settings: { model: { provider: "custom", id: session.model } },
	}, null, 2));
	fs.writeFileSync(path.join(chats, session.practiceId + ".json"), JSON.stringify({
		version: 1, id: session.practiceId, kind: "practice", title: session.practiceTitle,
		createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(),
		settings: { model: { provider: "custom", id: session.model } }, messages: [],
	}, null, 2));
	// Inert graph truth is seeded by the HOST fixture before boot, never by
	// plugin code. The caller must set LH_DATA_DIR to this disposable home/data
	// (as smoke-server.mjs does). Exclusive writes refuse existing graph data.
	const graph = path.join(home, "data", "graph");
	fs.mkdirSync(graph, { recursive: true });
	const fixture = PLUGIN_KNOWLEDGE_FIXTURE;
	const createdAt = "2026-11-01T00:00:00.000Z";
	const provenance = [{ chatId: fixture.sourceId, messageId: "" }];
	const nodes = [
		{ id: fixture.premiseId, name: "Fixture premise", statement: "This is an inert picker premise.", aliases: [], createdAt, provenance },
		{ id: fixture.conclusionId, name: "Fixture conclusion", statement: "This is an inert picker conclusion.", aliases: [], createdAt, provenance },
	];
	fs.writeFileSync(path.join(graph, "nodes.jsonl"), nodes.map(node => JSON.stringify(node)).join("\n") + "\n", { flag: "wx" });
	fs.writeFileSync(path.join(graph, "chains.jsonl"), JSON.stringify({ id: fixture.chainId, premises: [fixture.premiseId], conclusion: fixture.conclusionId, createdAt, provenance }) + "\n", { flag: "wx" });
	fs.writeFileSync(path.join(graph, "sources.json"), JSON.stringify({ [fixture.sourceId]: { id: fixture.sourceId, filePath: fixture.sourceLabel + ".md", importedAt: createdAt } }) + "\n", { flag: "wx" });
	return pluginRoot;
}

export async function verifyPluginServer(url, home, headers = {}) {
	const directory = path.join(home, "data", "plugins", "native-smoke");
	const activated = path.join(directory, "data", "activated.txt");
	const disabled = path.join(directory, "data", "disabled.txt");
	const jsonRequest = async (route, method, body, expected = 200) => {
		const response = await fetch(url + route, { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
		const payload = await response.json();
		if (response.status !== expected) throw new Error(`${method} ${route}: ${response.status}: ${JSON.stringify(payload)}`);
		return payload;
	};
	const listing = await (await fetch(url + "/api/plugins", { headers })).json();
	const plugin = listing.plugins?.find((item) => item.id === "native-smoke");
	if (!plugin || plugin.enabled || plugin.status !== "disabled") throw new Error("External plugins must be discovered disabled without executing code");
	if (fs.existsSync(activated)) throw new Error("Disabled plugin backend was evaluated");
	await jsonRequest("/api/plugins/native-smoke", "PUT", { enabled: true });
	const proof = await jsonRequest("/api/plugins/native-smoke/call", "POST", { operation: "proof", input: "packaged-runtime" });
	if (proof.result?.answer !== "packaged-runtime" || !proof.result.node || proof.result.data !== path.join(directory, "data") || proof.result.learning !== path.join(home, "data")) throw new Error("Native backend/context/bridge proof failed");
	if (!fs.existsSync(activated)) throw new Error("Native backend did not activate");
	const admission = await jsonRequest("/api/plugins/native-smoke/call", "POST", { operation: "admission-status" });
	if (admission.result?.tasks?.length !== 0 || admission.result?.counts?.requests !== 0 || admission.result?.counts?.active !== 0) throw new Error("Plugin activation must not automatically start worker/model requests");
	const questions = await jsonRequest("/api/plugins/native-smoke/call", "POST", { operation: "question-status" });
	if (questions.result?.counts?.requests !== 0 || questions.result?.requests?.length !== 0) throw new Error("Question registration must not start a native turn");
	const mock = new URL(admission.result.mockBase);
	if (mock.protocol !== "http:" || mock.hostname !== "127.0.0.1" || mock.pathname !== "/v1" || !mock.port) throw new Error("Fixture mock must bind an ephemeral loopback endpoint");
	for (const asset of ["main.js", "assets/helper.js", "assets/markdown-proof.js", "assets/question-proof.js", "assets/session-proof.js"]) {
		const response = await fetch(`${url}/api/plugins/native-smoke/assets/${asset}`, { headers });
		if (response.status !== 200 || !response.headers.get("content-type")?.includes("javascript")) throw new Error(`Frontend module unavailable: ${asset}`);
	}
	const image = await fetch(`${url}/api/plugins/native-smoke/assets/assets/markdown-proof.svg`, { headers });
	if (image.status !== 200 || !image.headers.get("content-type")?.includes("image/svg+xml") || !(await image.text()).includes('width="48" height="24"')) throw new Error("Local static Markdown image fixture unavailable");
	for (const asset of ["backend.cjs", "manifest.json", "data/private.json"]) {
		const response = await fetch(`${url}/api/plugins/native-smoke/assets/${asset}`, { headers });
		if (response.ok) throw new Error(`Private package file exposed as asset: ${asset}`);
	}
	await jsonRequest("/api/plugins/native-smoke", "PUT", { enabled: false });
	if (!fs.existsSync(disabled) || !fs.existsSync(path.join(directory, "data", "private.json"))) throw new Error("Disable failed cleanup or deleted plugin data");
	// Do not configure this activation's URL: browser enable creates a fresh
	// ephemeral listener. Disable must await closure of the retained handle.
	let mockStillListening = false;
	try {
		const response = await fetch(mock + "/models", { signal: AbortSignal.timeout(2_000) });
		await response.text();
		mockStillListening = true;
	} catch { /* Connection refusal/abort is expected after cooperative cleanup. */ }
	if (mockStillListening) throw new Error("Disabled plugin leaked its loopback mock listener");
	const stopped = await fetch(url + "/api/plugins/native-smoke/call", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ operation: "proof" }) });
	if (stopped.ok) throw new Error("Disabled plugin accepted operations");
	console.log("[smoke-server] external plugin: disabled discovery → native backend/bridge/assets + idle loopback fixture → cooperative disable closes mock; data preserved");
}
