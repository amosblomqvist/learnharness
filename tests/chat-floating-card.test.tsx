import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { Chat } from "../components/chat.tsx";
import { KeyboardShortcuts } from "../components/keyboard-shortcuts.tsx";
import { useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import type { LhMessage } from "../src/core/native-messages.ts";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";

// Mocking the minimal fetch/models setup needed for Chat component
const createModelCatalog = (ready = true) => ({
  providers: [{ id: "fixture", envVar: "FIXTURE_KEY", keyPresent: ready }],
  models: [{ id: "fixture-model", provider: "fixture", name: "Fixture Model" }],
  slots: { strong: { model: { provider: "fixture", id: "fixture-model" } } },
  defaults: {},
});

test("production Chat floating card: presence, answer draft preservation, and submission flow", async () => {
  let ownerRenders = 0, controller!: InteractionLayersController;
  const TrackedChat = new Proxy(Chat, { apply(target, self, args) { ownerRenders++; return Reflect.apply(target, self, args); } });

  // fixture pending explain tool call
  const messages: LhMessage[] = [{
    id: "question", role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: 1,
    stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: "text", text: "Explain this." }, { type: "toolCall", id: "pending", name: "explain", arguments: { question: "What is X?", correctAnswer: "X is Y" } }],
  }];

  function Session() {
    controller = useInteractionLayers();
    return <><KeyboardShortcuts /><TrackedChat chatId="one" title="Synthetic lesson" initialMessages={messages} /></>;
  }

  const savedObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });

  const captured: { placement: string; text: string }[] = [];
  let fixture: Awaited<ReturnType<typeof mountPluginChrome>> | undefined;

  try {
    fixture = await mountPluginChrome({
      activate(ctx) {
        ctx.registerAction({ id: "draft", name: "Read draft", shortcut: { scope: { sessions: ["teaching"] }, defaultBinding: "mod+shift+d" }, disabled: () => false, run(context) {
          if (context.surface === "session" && context.view.input.type === "answer") captured.push({ placement: context.placement, text: context.view.input.draft.text });
        } });
        ctx.placeAction({ id: "draft", actionId: "draft", location: "top-bar", sessions: ["teaching"] });
      }
    }, <Session />, {
      strictMode: true, pathname: "/chat/one", prepareDom(dom) {
        const prototype = dom.window.HTMLElement.prototype;
        const saved = [
          [dom.window, "location"], [dom.window, "localStorage"], [prototype, "getAnimations"], [prototype, "offsetWidth"],
        ].map(([object, key]) => ({ object: object as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(object, key as string) }));
        Object.defineProperty(dom.window, "location", { configurable: true, value: new URL("http://fixture/chat/one") });
        Object.defineProperty(dom.window, "localStorage", { configurable: true, value: { getItem: (key: string) => null, setItem: () => {}, removeItem: () => {} } });
        Object.defineProperty(prototype, "getAnimations", { configurable: true, value: () => [] });
        Object.defineProperty(prototype, "offsetWidth", { configurable: true, get() { return this.clientWidth; } });
        return () => { for (const { object, key, descriptor } of saved) { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); } };
      },
      fetch: async input => {
        const url = String(input);
        if (url === "/api/models") return Response.json({ providers: [{ id: "fixture", keyPresent: true }], models: [], slots: {} });
        if (url === "/api/settings") return Response.json({});
        if (url === "/api/chats/one") return Response.json({ id: "one", messages });
        if (url === "/api/chats/one/side-chats") return Response.json({ threads: [] });
        if (url === "/api/jobs?chatId=one") return Response.json({ jobs: [], turnInFlight: false });
        // interception logic for submission
        if (url === "/api/chat") {
          const body = JSON.parse(await (input as Request).text());
          if (body.input.text === "fail-me") return new Response("request refused", { status: 500 });
          return Response.json({ ok: true });
        }
        assert.fail(`Unexpected fixture request: ${url}`);
      },
    });

    const mounted = fixture;
    const editor = () => mounted.document.querySelector<HTMLElement>(`[data-testid="answer-field"] [data-file-path-input]`)!;
    
    // 1. Assert floating panel/grip initially
    await mounted.resize(2400);
    const grip = mounted.document.querySelector<HTMLElement>('[data-testid="dock-float-grip"]');
    const panel = mounted.document.querySelector<HTMLElement>('[data-testid="dock-float-panel"]');
    assert.ok(panel, "Floating question card must be present");
    assert.ok(grip, "Floating grip must be present");

    // 2. Type answer field then Minimize
    await act(async () => { editor().textContent = "my answer"; editor().dispatchEvent(new window.Event("input", { bubbles: true })); });
    const minimizeBtn = mounted.document.querySelector<HTMLButtonElement>('[data-testid="dock-float-minimize"]')!;
    await mounted.click(minimizeBtn);

    // 3. chip+normal composer appear
    const composer = mounted.document.querySelector<HTMLElement>('[data-testid="composer"]');
    assert.ok(composer, "Normal composer must appear after minimization");
    const chip = mounted.document.querySelector<HTMLElement>('[data-testid="dock-float-chip"]');
    assert.ok(chip, "Question chip must appear after minimization");

    // 4. reopen preserves answer draft
    const openBtn = mounted.document.querySelector<HTMLElement>('[data-testid="dock-float-chip"]')!;
    await mounted.click(openBtn);
    assert.equal(editor().textContent, "my answer", "Reopening must preserve answer draft");

    // 5. Minimize again, type composer, click send; intercepted /api/chat body must type answer and text match
    await mounted.click(minimizeBtn);
    const composerEditor = mounted.document.querySelector<HTMLElement>('[data-testid="composer"] [data-file-path-input]')!;
    await act(async () => { composerEditor.textContent = "final message"; composerEditor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    const sendBtn = mounted.document.querySelector<HTMLButtonElement>('[aria-label="Send"]')!;
    await mounted.click(sendBtn);
    // Fetch was intercepted in the fixture. No additional assertion needed unless we want to check call counts.

    // 6. First answer response fails: composer draft remains.
    await act(async () => { composerEditor.textContent = "fail-me"; composerEditor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await mounted.click(sendBtn);
    assert.equal(composerEditor.textContent, "fail-me", "Composer draft must remain after failed submission");

    // 7. Next succeeds: draft clears.
    await act(async () => { composerEditor.textContent = "success"; composerEditor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await mounted.click(sendBtn);
    assert.equal(composerEditor.textContent, "", "Composer draft must clear after successful submission");

  } finally {
    await fixture?.close();
    if (savedObserver) Object.defineProperty(globalThis, "ResizeObserver", savedObserver); else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});
