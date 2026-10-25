import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { createRequire } from "node:module";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { ChatGPTBackgroundAccess, ChatGPTConnection, ChatGPTUIProvider, CHATGPT_NOTICE, CHATGPT_DISCONNECT_COPY } from "../components/settings/chatgpt-connection.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { ModelControl } from "../components/model-picker.tsx";
import type { ChatGPTStatus, ChatGPTControlBridge } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: () => null, setItem() {} } });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const account = (id = "private-registration-id", email = "learner@example.invalid", connected = true) => ({ id, email, registration: "private-issued-client", connected, planEnabled: connected, canSignInAgain: !connected });
const disconnected = (allowBackgroundUse = true): ChatGPTStatus => ({ available: true, pending: false, allowBackgroundUse, activeId: null, accounts: [account("signed-out-record", "signed-out@example.invalid", false)], error: null });
const connected = (allowBackgroundUse = true): ChatGPTStatus => ({ ...disconnected(allowBackgroundUse), activeId: "private-registration-id", accounts: [account(), ...disconnected().accounts] });
const storageError = "ChatGPT credentials could not be read or saved. Check local file access, then reconnect before making requests.";
const warning = "Account disconnected locally. Remote revocation could not be confirmed.";
const errorReply = () => ({ error: storageError } as ChatGPTStatus);
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(initial = disconnected(), overrides: Partial<ChatGPTControlBridge> = {}) {
 let status = initial;
 const calls = { login: [] as (string | undefined)[], cancel: 0, consent: [] as boolean[], disconnect: [] as string[], select: [] as string[], logout: 0 };
 const listeners = new Set<() => void>();
 function push(next: ChatGPTStatus) { status = next; for (const cb of listeners) cb(); }
 const bridge: ChatGPTControlBridge = {
  status: async () => status,
  login: async (id) => { calls.login.push(id); push({ ...status, pending: true, error: null }); return status; },
  cancel: async () => { calls.cancel++; push({ ...status, pending: false, error: null }); return status; },
  select: async (id) => { calls.select.push(id); push({ ...status, activeId: id }); return status; },
  disconnect: async (id) => { calls.disconnect.push(id); push({ ...status, activeId: status.activeId === id ? null : status.activeId, accounts: status.accounts.filter((a) => a.id !== id) }); return status; },
  logout: async () => { calls.logout++; return status; },
  consent: async (enabled) => { calls.consent.push(enabled); push({ ...status, allowBackgroundUse: enabled }); return status; },
  onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }, ...overrides,
 };
 window.lh = { expandWindow() {}, chatgpt: bridge };
 return { calls, bridge, push, get status() { return status; }, complete() { push({ ...connected(status.allowBackgroundUse), pending: false }); } };
}
function recoveryController({ writeFails = false, tokens = "valid" }: { writeFails?: boolean; tokens?: "valid" | "missing" | "restricted" | "scope" | "expired" } = {}) {
 const require = createRequire(import.meta.url); const { createChatGPT, SCOPES } = require("../electron/chatgpt.cjs"); const { chatGPTControl } = require("../electron/chatgpt-ipc.cjs");
 const registration: any = { id: "fixture", clientId: "oaiapp_fixture", issuer: "https://auth.openai.com", subject: "fixture", email: "fixture@example.invalid", tokens: { accessToken: "fake-access", refreshToken: "fake-refresh", idToken: "fake-id", expiresAt: tokens === "expired" ? 0 : Date.now() + 3600000, scopes: tokens === "scope" ? ["openid"] : [...SCOPES] } };
 if (tokens === "missing") delete registration.tokens; if (tokens === "restricted") registration.reconnectRequired = true;
 let saved = { version: 1, hostId: "urn:uuid:offline-recovery", activeId: "fixture", allowBackgroundUse: true, registrations: [registration] };
 let browserAttempts = 0, tokenRequests = 0; const listeners = new Set<() => void>();
 const service = createChatGPT({ store: { read: async () => structuredClone(saved), write: async (next: typeof saved) => { if (writeFails) throw Object.assign(new Error("fake-storage-failure"), { code: "storage" }); saved = structuredClone(next); } }, openExternal: () => { browserAttempts++; throw new Error("No real browser"); }, fetch: async (url: string) => { tokenRequests++; assert.equal(tokens, "expired"); assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token"); return Response.json({ error: "invalid_grant" }, { status: 401 }); }, onChange: () => { for (const cb of listeners) cb(); } });
 window.lh = { expandWindow() {}, chatgpt: { status: () => chatGPTControl({ op: "status" }, service), consent: (enabled) => chatGPTControl({ op: "consent", enabled }, service), login: (id) => chatGPTControl({ op: "login", id }, service), cancel: () => chatGPTControl({ op: "cancel" }, service), select: (id) => chatGPTControl({ op: "select", id }, service), disconnect: (id) => chatGPTControl({ op: "disconnect", id }, service), logout: (id) => chatGPTControl({ op: "logout", id }, service), onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); } } };
 return { service, get saved() { return saved; }, get browserAttempts() { return browserAttempts; }, get tokenRequests() { return tokenRequests; } };
}
async function mount(children: React.ReactNode = <ChatGPTConnection />) {
 host = document.createElement("div"); document.body.append(host); root = createRoot(host);
 await act(async () => root!.render(<ChatGPTUIProvider>{children}</ChatGPTUIProvider>));
}
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
async function click(element: HTMLElement) { assert(element); await act(async () => element.click()); }
function button(text: string, scope: ParentNode = document) { return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === text)!; }
const toggle = () => document.querySelector<HTMLElement>('[data-testid="chatgpt-account-dialog"] [role="switch"]')!;
async function selectAccount(label: string, id: string) {
 const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; assert(select);
 await act(async () => { Object.defineProperty(select, "value", { configurable: true, writable: true, value: id }); select.dispatchEvent(new window.Event("change", { bubbles: true })); });
}
async function begin() { await click(byTest("chatgpt-login")); await click(byTest("chatgpt-proceed")); }
async function confirmDisconnect() { await click(byTest("chatgpt-disconnect")); await click(byTest("chatgpt-confirm-disconnect")); }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; delete window.lh; globalThis.fetch = originalFetch; });

test("Providers is the first/default page; General is last and other pages keep relative order", () => {
 const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
 const ids = [...html.matchAll(/data-testid="settings-nav-([^"]+)"/g)].map((m) => m[1]);
 assert.deepEqual(ids, ["keys", "agent", "appearance", "graph", "keyboard", "general"]);
 assert.match(html, /settings-nav-keys[^>]*aria-current="true"/); assert.match(html, />Providers<\/button>/);
 assert.doesNotMatch(html, />Model providers<\/button>/);
});

test("Providers has exactly four ordered sections; unknown variables stay masked/read-only at the end of Model API keys", async () => {
 globalThis.fetch = async (url) => {
  assert.equal(url, "/api/keys");
  return Response.json({ providers: [{ id: "openai", envVar: "OPENAI_API_KEY", label: "OpenAI" }], keys: [{ id: "FUTURE_VAR", info: null, present: true, masked: "…abcd", source: "file", shadowedByEnv: false }] });
 };
 fixture(); await mount(<KeysSection />);
 const headings = [...document.querySelectorAll('[data-testid^="group-"] > p')].map((el) => el.textContent);
 assert.deepEqual(headings, ["Model API keys", "Subscriptions", "Dictation", "Search"]);
 assert(byTest("key-deepgram_api_key").closest('[data-testid="group-dictation"]'));
 assert(byTest("key-tavily_api_key").closest('[data-testid="group-search"]'));
 assert(byTest("key-brave_api_key").closest('[data-testid="group-search"]'));
 assert(byTest("unknown-FUTURE_VAR").closest('[data-testid="group-provider-keys"]'));
 assert(byTest("group-unknown-keys").parentElement?.lastElementChild === byTest("group-unknown-keys"));
 assert.equal(byTest("unknown-FUTURE_VAR").textContent, "FUTURE_VAR…abcd"); assert(!byTest("unknown-FUTURE_VAR").querySelector("input, button"));
});

test("disconnected row uses shared Connect action; initial default is ON; cancel discards draft without OAuth/global mutation", async () => {
 const f = fixture(); await mount(<ChatGPTConnection setup />);
 assert.equal(byTest("chatgpt-connection").textContent, "ChatGPTConnect");
 assert(!document.body.textContent?.includes(CHATGPT_NOTICE)); const trigger = byTest("chatgpt-login");
 assert.match(trigger.className, /cursor-pointer/); assert.match(trigger.className, /hover:bg-accent/); assert.match(trigger.className, /focus-visible:ring/);
 await click(trigger); assert.equal(f.calls.login.length, 0); assert(document.body.textContent?.includes(CHATGPT_NOTICE));
 assert.equal(byTest("chatgpt-account-dialog").querySelector("h2")?.textContent, "ChatGPT");
 assert.equal(byTest("chatgpt-proceed").textContent, "Continue with ChatGPT"); assert(byTest("chatgpt-proceed").querySelector('img[src="/siwc/chatgpt-logo-white.svg"]'));
 assert(!button("Continue", byTest("chatgpt-account-dialog")), "ChatGPT remains one step, with disclosure and toggle together");
 assert.equal(toggle().getAttribute("aria-checked"), "true");
 assert.equal(toggle().getAttribute("aria-label"), "Allow background use for all ChatGPT accounts");
 assert(byTest("chatgpt-global-background").textContent?.includes("Background work counts toward your ChatGPT plan usage."));
 await click(toggle());
 await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert.equal(f.calls.login.length, 0); assert.deepEqual(f.calls.consent, []); assert.equal(f.calls.cancel, 0);
 await click(byTest("chatgpt-login")); assert.equal(toggle().getAttribute("aria-checked"), "true");
});

for (const value of [true, false]) test(`untouched initial sign-in preserves existing global ${value} through verified completion`, async () => {
 const f = fixture(disconnected(value)); await mount(); await click(byTest("chatgpt-login"));
 assert.equal(toggle().getAttribute("aria-checked"), String(value)); await click(byTest("chatgpt-proceed"));
 assert(document.body.textContent?.includes("Waiting for browser sign-in")); assert.deepEqual(f.calls.consent, []);
 await act(async () => f.complete()); assert.deepEqual(f.calls.consent, []); assert.equal(f.status.allowBackgroundUse, value);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert(button("Manage…"));
});

for (const value of [true, false]) test(`explicit global draft ${!value} is applied only after actual pending/onChange verified completion`, async () => {
 const f = fixture(disconnected(value)); await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
 assert.deepEqual(f.calls.consent, []); assert((byTest("chatgpt-proceed") as HTMLButtonElement).disabled);
 await act(async () => f.complete()); assert.deepEqual(f.calls.consent, [!value]); assert.equal(f.status.allowBackgroundUse, !value);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 await act(async () => f.push(f.status)); assert.deepEqual(f.calls.consent, [!value]);
});

test("Cancel after initial IPC promise ends cancels actual OAuth; late completion cannot apply draft or close another dialog", async () => {
 const f = fixture(); await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); assert.equal(f.calls.cancel, 1);
 await click(byTest("chatgpt-login")); const dialog = byTest("chatgpt-account-dialog");
 await act(async () => f.complete()); assert.deepEqual(f.calls.consent, []); assert(byTest("chatgpt-account-dialog") === dialog); assert.equal(f.calls.login.length, 1);
});

test("review: late cancel acknowledgement must not roll back newer global authority", async () => {
 const held = deferred<ChatGPTStatus>();
 const f = fixture(disconnected(true), { cancel: async () => { f.calls.cancel++; return held.promise; } });
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await act(async () => f.push(disconnected(false)));
 await act(async () => held.resolve(disconnected(true)));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 assert.equal(f.status.allowBackgroundUse, false, "backend truth remains OFF");
 await click(byTest("chatgpt-login"));
 assert.equal(toggle().getAttribute("aria-checked"), "false", "new disclosure must use the newer authoritative global OFF, not the old cancellation snapshot");
});

test("late cancel acknowledgement cannot roll newer global ON back to OFF", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(disconnected(false), { cancel: () => held.promise });
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await act(async () => f.push(disconnected(true))); await act(async () => held.resolve(disconnected(false)));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert.equal(f.status.allowBackgroundUse, true);
 await click(byTest("chatgpt-login")); assert.equal(toggle().getAttribute("aria-checked"), "true"); assert.deepEqual(f.calls.consent, []);
});

test("cancel reconciliation read is itself fenced when a newer status arrives before that read returns", async () => {
 const held = deferred<ChatGPTStatus>(), current = deferred<ChatGPTStatus>();
 const f = fixture(disconnected(), { cancel: () => held.promise }); let reads = 0;
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await act(async () => f.push(disconnected(false)));
 f.bridge.status = () => { reads++; return current.promise; };
 await act(async () => held.resolve(disconnected(true))); assert.equal(reads, 1);
 f.bridge.status = async () => f.status;
 await act(async () => f.push(disconnected(true))); await act(async () => current.resolve(disconnected(false)));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 await click(byTest("chatgpt-login")); assert.equal(toggle().getAttribute("aria-checked"), "true"); assert.deepEqual(f.calls.consent, []);
});

test("late cancellation preserves newer availability and error instead of dismissing an unrelated failure", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { cancel: () => held.promise });
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await act(async () => f.push({ ...disconnected(false), available: false, error: storageError }));
 await act(async () => held.resolve(disconnected(true)));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError); assert((byTest("chatgpt-login") as HTMLButtonElement).disabled);
});

test("error-only cancellation reconciliation keeps last valid authority and leaves cancellation recoverable", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { cancel: () => held.promise });
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await act(async () => f.push(disconnected(false)));
 f.bridge.status = async () => errorReply(); await act(async () => held.resolve(disconnected(true)));
 assert(byTest("chatgpt-account-dialog")); assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError);
 assert.equal((button("Cancel", byTest("chatgpt-account-dialog")) as HTMLButtonElement).disabled, false);
 f.bridge.status = async () => f.status; f.bridge.cancel = async () => f.status;
 await click(button("Cancel", byTest("chatgpt-account-dialog")));
 await click(byTest("chatgpt-login")); assert.equal(toggle().getAttribute("aria-checked"), "false"); assert.deepEqual(f.calls.consent, []);
});

test("email-only connected selector and Manage remain responsive; account selection never changes global OFF", async () => {
 const initial = connected(false); initial.accounts.push(account("second", "second@example.invalid"), account("missing", ""));
 const f = fixture(initial); await mount();
 assert.deepEqual([...document.querySelectorAll('select[aria-label="ChatGPT account"] option')].map((o) => o.textContent), ["learner@example.invalid", "second@example.invalid", "ChatGPT account"]);
 assert.doesNotMatch(byTest("chatgpt-connection").textContent!, /private-registration|private-issued| · active|signed-out/);
 assert.match(byTest("chatgpt-connection").firstElementChild!.className, /items-center/);
 const row = byTest("chatgpt-connection").firstElementChild!;
 assert.equal(row.children[0]!.textContent, "ChatGPT"); assert.equal(row.children[1]!.tagName, "SELECT"); assert.equal(row.children[2]!.textContent, "Manage…");
 assert.match(row.children[2]!.className, /text-muted-foreground/); assert(!row.textContent?.includes("Connected"));
 await selectAccount("ChatGPT account", "second"); assert.deepEqual(f.calls.select, ["second"]); assert.equal(f.status.allowBackgroundUse, false);
 await click(button("Manage…")); assert(byTest("chatgpt-managed-identity").textContent?.includes("second@example.invalid"));
 assert.deepEqual([...byTest("chatgpt-account-footer").querySelectorAll("button")].map((b) => b.textContent), ["Disconnect", "Close"]);
 const dialog = byTest("chatgpt-account-dialog").innerHTML;
 assert(dialog.indexOf('data-testid="chatgpt-managed-identity"') < dialog.indexOf('data-testid="chatgpt-account-actions"'));
 assert(dialog.indexOf('data-testid="chatgpt-global-background"') < dialog.indexOf('data-testid="chatgpt-managed-identity"'));
 assert(!byTest("chatgpt-account-dialog").querySelector('[data-testid="chatgpt-privacy-notice"]'));
 assert.equal(byTest("chatgpt-account-dialog").querySelector("h2")?.textContent, "ChatGPT");
 assert(byTest("chatgpt-account-dialog").querySelector('a[href="https://openai.com/policies/privacy-policy/"]'));
 assert(byTest("chatgpt-account-dialog").querySelector('a[href="https://chatgpt.com/settings/usage"]'));
 await click(toggle()); assert.deepEqual(f.calls.consent, [true]); assert.equal(toggle().getAttribute("aria-checked"), "true");
 await click(button("Close")); await selectAccount("ChatGPT account", "private-registration-id"); assert.equal(f.status.allowBackgroundUse, true);
 assert.equal(f.calls.logout, 0);
});

test("Disconnect is the quiet red left-footer action below identity; confirmation Cancel never forgets", async () => {
 assert.deepEqual(CHATGPT_DISCONNECT_COPY, { title: "Disconnect account?", body: "This removes the saved account and its credentials from this device." });
 const f = fixture(connected()); await mount(); await click(button("Manage…"));
 assert.equal(byTest("chatgpt-account-actions").textContent, "Disconnect"); assert.match(byTest("chatgpt-disconnect").className, /text-red/);
 assert.equal(byTest("chatgpt-account-footer").firstElementChild, byTest("chatgpt-account-actions"));
 assert.equal(byTest("chatgpt-account-footer").lastElementChild?.lastElementChild, button("Close"));
 assert(!byTest("chatgpt-account-footer").contains(byTest("chatgpt-add-accounts")));
 await click(byTest("chatgpt-disconnect")); assert.equal(f.calls.disconnect.length, 0);
 assert.equal(byTest("chatgpt-account-dialog").querySelector("h2")?.textContent, "ChatGPT");
 assert(byTest("chatgpt-disconnect-confirmation").textContent?.includes(CHATGPT_DISCONNECT_COPY.title));
 assert(byTest("chatgpt-disconnect-confirmation").textContent?.includes(CHATGPT_DISCONNECT_COPY.body));
 assert(!document.body.textContent?.includes("delete your OpenAI"));
 await click(button("Cancel", byTest("chatgpt-disconnect-confirmation"))); assert(byTest("chatgpt-disconnect")); assert.deepEqual(f.calls.disconnect, []);
 await click(button("Close")); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

for (const count of [1, 3]) test(`Add accounts reuses the actual add flow with ${count} saved accounts; opening and cancelling preserve the connection`, async () => {
 const initial = connected(count === 3);
 initial.accounts = [account(), ...Array.from({ length: count - 1 }, (_, i) => account(`saved-${i}`, `saved-${i}@example.invalid`))];
 const f = fixture(initial); const before = structuredClone(initial); await mount(); await click(button("Manage…"));
 assert.deepEqual([...byTest("chatgpt-account-footer").querySelectorAll("button")].map((b) => b.textContent), ["Disconnect", "Close"]);
 assert.equal(byTest("chatgpt-add-accounts").getAttribute("data-variant"), "ghost");
 assert.equal(byTest("chatgpt-add-accounts").parentElement, byTest("chatgpt-account-strip"));
 assert.match(byTest("chatgpt-add-accounts").className, /cursor-pointer/);
 await click(byTest("chatgpt-add-accounts"));
 assert(byTest("chatgpt-privacy-notice").textContent?.includes(CHATGPT_NOTICE)); assert(byTest("chatgpt-proceed"));
 assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Saved ChatGPT account"]')?.value, "");
 assert.equal(toggle().getAttribute("aria-checked"), String(before.allowBackgroundUse));
 assert.deepEqual(f.status, before); assert.deepEqual(f.calls.login, []); assert.deepEqual(f.calls.select, []); assert.deepEqual(f.calls.disconnect, []);
 await click(toggle()); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert.deepEqual(f.status, before); assert.deepEqual(f.calls.consent, []); assert.equal(f.calls.cancel, 0);
 await click(button("Manage…")); await click(byTest("chatgpt-add-accounts"));
 assert.equal(toggle().getAttribute("aria-checked"), String(before.allowBackgroundUse));
 await click(byTest("chatgpt-proceed")); assert.deepEqual(f.calls.login, [undefined], "existing login machinery receives no saved/current account ID");
 assert.equal(f.status.activeId, before.activeId); assert.deepEqual(f.status.accounts, before.accounts);
 await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert.deepEqual(f.status, before); assert.equal(f.calls.cancel, 1); assert.deepEqual(f.calls.consent, []); assert.deepEqual(f.calls.disconnect, []);
});

test("ChatGPT Sign in again is reserved for a saved disconnected account and keeps its existing registration flow", async () => {
 const f = fixture(connected(false)); await mount(); await click(button("Manage…"));
 assert(!button("Sign in again")); await selectAccount("Manage ChatGPT account", "signed-out-record"); assert(button("Sign in again"));
 await click(button("Sign in again")); assert.equal(byTest("chatgpt-account-dialog").querySelector("h2")?.textContent, "ChatGPT");
 assert(byTest("chatgpt-privacy-notice")); assert(toggle()); assert.equal(toggle().getAttribute("aria-checked"), "false");
 assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Saved ChatGPT account"]')?.value, "signed-out-record"); assert.deepEqual(f.calls.login, []);
 await click(byTest("chatgpt-proceed")); assert.deepEqual(f.calls.login, ["signed-out-record"]); assert.equal(f.status.activeId, "private-registration-id");
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); assert.equal(f.calls.cancel, 1); assert.deepEqual(f.calls.disconnect, []); assert.deepEqual(f.calls.consent, []);
});
test("actual controller storage-write failure is not ChatGPT authorization recovery even while available stays true", async () => {
 const f = recoveryController({ writeFails: true });
 try {
  await mount(); await click(button("Manage…")); assert(!button("Sign in again")); await click(toggle());
  const status = await f.service.status(); assert.equal(status.available, true); assert.equal(status.pending, false); assert.equal(status.accounts[0].connected, false); assert.equal(status.accounts[0].planEnabled, false); assert.equal(status.error, storageError);
  assert(!button("Sign in again"), "a failed credential write must not offer reauthorization");
  assert.equal(status.accounts[0].canSignInAgain, false); assert.equal(f.browserAttempts, 0); assert.equal(f.tokenRequests, 0);
 } finally { await act(async () => f.service.close()); }
});
for (const tokens of ["missing", "restricted", "scope"] as const) test(`actual controller ${tokens} authorization permits recovery, but paused/closed state does not`, async () => {
 const f = recoveryController({ tokens });
 try {
  await mount(); await click(byTest("chatgpt-login")); await selectAccount("Saved ChatGPT account", "fixture"); await click(button("Manage…"));
  assert.equal((await f.service.status()).accounts[0].canSignInAgain, true); assert(button("Sign in again"));
  assert.equal(f.saved.registrations[0].canSignInAgain, undefined, "eligibility is projected, never persisted");
  await act(async () => f.service.pause()); assert.equal((await f.service.status()).accounts[0].canSignInAgain, false); assert(!button("Sign in again"));
  await act(async () => f.service.resume()); assert.equal((await f.service.status()).accounts[0].canSignInAgain, true); assert(button("Sign in again"));
  await act(async () => f.service.close()); assert.equal((await f.service.status()).accounts[0].canSignInAgain, false); assert(!button("Sign in again"));
  assert.equal(f.browserAttempts, 0); assert.equal(f.tokenRequests, 0);
 } finally { await act(async () => f.service.close()); }
});
test("storage denial overrides an otherwise eligible remembered ChatGPT authorization recovery", async () => {
 const f = recoveryController({ tokens: "missing", writeFails: true });
 try {
  await mount(); await click(byTest("chatgpt-login")); await selectAccount("Saved ChatGPT account", "fixture"); await click(button("Manage…")); assert(button("Sign in again"));
  await click(toggle()); const status = await f.service.status(); assert.equal(status.available, true); assert.equal(status.error, storageError); assert.equal(status.accounts[0].canSignInAgain, false); assert(!button("Sign in again"));
  assert.equal(f.browserAttempts, 0); assert.equal(f.tokenRequests, 0);
 } finally { await act(async () => f.service.close()); }
});
test("actual invalid_grant recovery preserves remembered identity and stages the existing registration flow", async () => {
 const f = recoveryController({ tokens: "expired" });
 try {
  await mount(); await click(button("Manage…")); assert.equal((await f.service.status()).accounts[0].canSignInAgain, false); assert(!button("Sign in again"));
  await act(async () => { await f.service.models(); });
  const status = await f.service.status(); assert.equal(status.available, true); assert.equal(status.accounts[0].connected, false); assert.equal(status.accounts[0].canSignInAgain, true);
  assert.equal(status.accounts[0].id, "fixture"); assert.equal(status.accounts[0].registration, "oaiapp_fixture"); assert.equal(f.saved.registrations[0].tokens, undefined);
  await click(button("Sign in again")); assert(byTest("chatgpt-privacy-notice")); assert(toggle()); assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Saved ChatGPT account"]')?.value, "fixture");
  assert.equal(f.tokenRequests, 1, "only the injected refresh response was requested"); assert.equal(f.browserAttempts, 0, "staging recovery never starts OAuth");
 } finally { await act(async () => f.service.close()); }
});
test("missing eligibility remains compatible but never implies authorization recovery; malformed eligibility is rejected", async () => {
 const initial = connected(); initial.accounts = [account()]; const f = fixture(initial); await mount(); await click(button("Manage…"));
 const legacy: ChatGPTStatus = { ...initial, accounts: initial.accounts.map(({ canSignInAgain: _ignored, ...a }) => ({ ...a, connected: false, planEnabled: false })) };
 await act(async () => f.push(legacy)); assert(!button("Sign in again")); assert(!document.querySelector('[role="alert"]'));
 for (const value of [null, "true", 1]) {
  await act(async () => f.push({ ...legacy, accounts: legacy.accounts.map((a) => ({ ...a, canSignInAgain: value })) } as unknown as ChatGPTStatus));
  assert(!button("Sign in again")); assert.equal(document.querySelector('[role="alert"]')?.textContent, "The ChatGPT connection could not be changed. Try again.");
 }
});
test("connected setup row retains the email dropdown before muted Manage", async () => {
 fixture(connected()); await mount(<ChatGPTConnection setup />);
 const row = byTest("chatgpt-connection").firstElementChild!; assert.equal(row.children[1]!.tagName, "SELECT"); assert.equal(row.children[2]!.textContent, "Manage…"); assert.match(row.children[2]!.className, /text-muted-foreground/);
});
test("Add accounts reuses the existing dialog's initial focus for the pre-auth transition", async () => {
 const previous = HTMLElement.prototype.focus; const focused: HTMLElement[] = [];
 HTMLElement.prototype.focus = function () { focused.push(this); };
 try {
  fixture(connected()); await mount(); await click(button("Manage…")); await click(byTest("chatgpt-add-accounts"));
  assert(focused.at(-1) === document.querySelector('select[aria-label="Saved ChatGPT account"]'));
 } finally { HTMLElement.prototype.focus = previous; }
});

test("Add accounts respects existing busy, pending and unavailable guards", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(connected(), { consent: () => held.promise });
 await mount(); await click(button("Manage…")); await click(toggle());
 assert((byTest("chatgpt-add-accounts") as HTMLButtonElement).disabled);
 await click(byTest("chatgpt-add-accounts")); assert(byTest("chatgpt-managed-identity")); assert(!document.querySelector('[data-testid="chatgpt-proceed"]'));
 await act(async () => held.resolve(f.status)); assert.equal((byTest("chatgpt-add-accounts") as HTMLButtonElement).disabled, false);
 await act(async () => f.push({ ...f.status, pending: true })); assert((byTest("chatgpt-add-accounts") as HTMLButtonElement).disabled);
 await act(async () => f.push({ ...f.status, pending: false, available: false })); assert((byTest("chatgpt-add-accounts") as HTMLButtonElement).disabled);
 assert.deepEqual(f.calls.login, []);
});

test("confirmed disconnect preserves identity/pending content until outcome, prevents duplicate clicks, then closes without selecting another account", async () => {
 const done = deferred<ChatGPTStatus>();
 const f = fixture(connected(false), { disconnect: (id) => { f.calls.disconnect.push(id); return done.promise; } });
 await mount(); await click(button("Manage…")); await confirmDisconnect();
 await click(byTest("chatgpt-confirm-disconnect")); assert.deepEqual(f.calls.disconnect, ["private-registration-id"]);
 const final = { ...disconnected(false), accounts: [account("other", "other@example.invalid")] };
 await act(async () => f.push(final));
 assert(byTest("chatgpt-disconnect-confirmation").textContent?.includes("learner@example.invalid"));
 assert((byTest("chatgpt-confirm-disconnect") as HTMLButtonElement).disabled); assert.equal(byTest("chatgpt-account-dialog").getAttribute("aria-busy"), "true");
 await act(async () => done.resolve(final));
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert(byTest("chatgpt-login")); assert.equal(f.status.activeId, null);
 assert.equal(f.status.allowBackgroundUse, false); assert.equal(f.calls.logout, 0);
});

test("signed-out legacy accounts remain manageable/forgettable without pretending selection is a usable connection", async () => {
 const f = fixture(); await mount(); assert.equal(byTest("chatgpt-connection").textContent, "ChatGPTConnect");
 await click(byTest("chatgpt-login")); await selectAccount("Saved ChatGPT account", "signed-out-record"); await click(button("Manage…"));
 assert(byTest("chatgpt-managed-identity").textContent?.includes("signed-out@example.invalid"));
 assert.deepEqual(f.calls.select, []); assert.equal(f.calls.login.length, 0); await confirmDisconnect();
 assert.deepEqual(f.calls.disconnect, ["signed-out-record"]); assert.equal(f.status.accounts.length, 0); assert.equal(f.status.allowBackgroundUse, true);
});

test("unconfirmed provider outcome is exactly the approved concise dismissible warning, never permanent red success/navigation advice", async () => {
 const f = fixture(connected(), { disconnect: async () => { const result = { ...disconnected(), accounts: [], error: warning }; f.push(result); return result; } });
 await mount(); await click(button("Manage…")); await confirmDisconnect();
 const alert = byTest("chatgpt-revocation-warning"); assert.equal(alert.textContent, warning); assert.doesNotMatch(alert.className, /text-red/);
 assert(!document.querySelector('[data-testid="chatgpt-disconnect"]')); assert(byTest("chatgpt-login"));
 await click(button("Dismiss", byTest("chatgpt-account-dialog"))); assert(!document.querySelector('[role="alert"]'));
 assert(!document.body.textContent?.includes("ChatGPT Settings"));
});

test("dismissed revocation warning stays dismissed across global setting changes but a new unconfirmed disconnect is shown", async () => {
 const initial = connected(); initial.error = warning;
 const f = fixture(initial, { disconnect: async () => { const next = { ...disconnected(false), accounts: [], error: warning }; f.push(next); return next; } });
 await mount(); await click(button("Dismiss")); await click(button("Manage…")); await click(toggle());
 assert.equal(toggle().getAttribute("aria-checked"), "false"); assert(!document.querySelector('[role="alert"]'));
 await confirmDisconnect(); assert.equal(byTest("chatgpt-revocation-warning").textContent, warning);
});

test("contextual Enable action opens the same global control without silently enabling; no foreground/provider clutter", async () => {
 const f = fixture(connected(false)); await mount(<><ChatGPTBackgroundAccess provider="chatgpt" /><ChatGPTBackgroundAccess provider="openai" /><ChatGPTConnection /></>);
 assert.equal([...document.querySelectorAll("button")].filter((b) => b.textContent === "Enable background use").length, 1);
 await click(button("Enable background use")); assert.deepEqual(f.calls.consent, []);
 assert.equal(toggle().getAttribute("aria-checked"), "false"); await click(toggle()); assert.deepEqual(f.calls.consent, [true]); assert(!button("Enable background use"));
 await act(async () => f.push(disconnected(false))); assert(!button("Enable background use"));
});

test("error-only disconnect reply preserves coherent status/confirmation and permits explicit retry, not false forgotten/connected success", async () => {
 const f = fixture(connected(), { disconnect: async () => errorReply() }); await mount(); await click(button("Manage…"));
 await assert.doesNotReject(confirmDisconnect); assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError);
 assert.equal((byTest("chatgpt-confirm-disconnect") as HTMLButtonElement).disabled, false); assert(byTest("chatgpt-disconnect-confirmation"));
 f.bridge.disconnect = async () => { const next = { ...disconnected(), accounts: [] }; f.push(next); return next; };
 await click(byTest("chatgpt-confirm-disconnect")); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert(byTest("chatgpt-login"));
});

for (const value of [true, false]) test(`global toggle keeps its normal cursor while saving ${!value}, without accepting duplicate clicks`, async () => {
 const held = deferred<ChatGPTStatus>();
 const f = fixture(connected(value), { consent: (enabled) => { f.calls.consent.push(enabled); return held.promise; } });
 await mount(); await click(button("Manage…")); await click(toggle());
 await act(async () => f.push(connected(!value)));
 assert((toggle() as HTMLButtonElement).disabled);
 assert(byTest("chatgpt-global-background").className.includes("[&>button:disabled]:cursor-auto"));
 assert.equal(toggle().getAttribute("aria-checked"), String(!value));
 await click(toggle()); assert.deepEqual(f.calls.consent, [!value]);
 await act(async () => held.resolve(connected(!value)));
 assert.equal((toggle() as HTMLButtonElement).disabled, false);
 assert(!byTest("chatgpt-global-background").className.includes("cursor-auto"));
});

test("global toggle retains the unavailable cursor if secure availability is lost during a save", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(connected(), { consent: () => held.promise });
 await mount(); await click(button("Manage…")); await click(toggle());
 const denied = connected(false); denied.available = false; denied.error = storageError;
 denied.accounts = denied.accounts.map((a) => ({ ...a, connected: false, planEnabled: false }));
 await act(async () => f.push(denied));
 assert((toggle() as HTMLButtonElement).disabled); assert.match(toggle().className, /cursor-not-allowed/);
 assert(!byTest("chatgpt-global-background").className.includes("cursor-auto"));
 await act(async () => held.resolve(connected(false)));
 assert((toggle() as HTMLButtonElement).disabled); assert(!byTest("chatgpt-global-background").className.includes("cursor-auto"));
});

test("error-only global consent reply keeps saved state visible and a recoverable error", async () => {
 fixture(connected(), { consent: async () => errorReply() }); await mount(); await click(button("Manage…"));
 await assert.doesNotReject(() => click(toggle())); assert.equal(toggle().getAttribute("aria-checked"), "true"); assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError);
 assert.equal((toggle() as HTMLButtonElement).disabled, false);
});

test("error-only login reply releases its operation without corrupting status or auto-retrying", async () => {
 let calls = 0; fixture(disconnected(), { login: async () => { calls++; return errorReply(); } }); await mount(); await assert.doesNotReject(begin);
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError); assert.equal((byTest("chatgpt-proceed") as HTMLButtonElement).disabled, false); assert.equal(calls, 1);
});

test("error-only initial global draft save leaves disclosure/error and duplicate completion cannot retry the setting", async () => {
 let calls = 0; const f = fixture(disconnected(), { consent: async () => { calls++; return errorReply(); } });
 await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed")); await act(async () => f.complete());
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError); assert(byTest("chatgpt-account-dialog"));
 await act(async () => f.push(f.status)); assert.equal(calls, 1); assert.equal(f.calls.login.length, 1);
});

test("error-only pending cancellation remains retryable and cannot apply a global draft", async () => {
 const f = fixture(disconnected(), { cancel: async () => { f.calls.cancel++; return errorReply(); } });
 await mount(); await begin(); await click(button("Cancel", byTest("chatgpt-account-dialog")));
 assert.equal(document.querySelector('[role="alert"]')?.textContent, storageError); assert(byTest("chatgpt-account-dialog"));
 f.bridge.cancel = async () => { f.calls.cancel++; const next = { ...f.status, pending: false }; f.push(next); return next; };
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); assert.equal(f.calls.cancel, 2); assert.deepEqual(f.calls.consent, []);
 assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("failed pending verification never applies draft/starts login/closes disclosure on a later clean status", async () => {
 const f = fixture(); await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
 await act(async () => f.push({ ...connected(), error: "ChatGPT sign-in could not be verified." }));
 await act(async () => f.push(connected())); assert.deepEqual(f.calls.consent, []); assert.equal(f.calls.login.length, 1); assert(byTest("chatgpt-account-dialog"));
});

test("saved-registration mismatch cannot complete the attempt or apply its global draft", async () => {
 const f = fixture(); await mount(); await click(byTest("chatgpt-login")); await selectAccount("Saved ChatGPT account", "signed-out-record");
 await click(toggle()); await click(byTest("chatgpt-proceed")); await act(async () => f.complete());
 assert.deepEqual(f.calls.consent, []); assert.deepEqual(f.calls.login, ["signed-out-record"]); assert(document.querySelector('[role="alert"]')); assert(byTest("chatgpt-account-dialog"));
});

test("account invalidation while initial global consent awaits IPC fences stale reply and preserves an unrelated later dialog", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { consent: () => held.promise });
 await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed")); await act(async () => f.complete());
 const other = { ...connected(), activeId: "other", accounts: [account("other", "other@example.invalid")] }; await act(async () => f.push(other));
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); await click(button("Manage…")); const dialog = byTest("chatgpt-account-dialog");
 await act(async () => held.resolve(connected(false))); assert(byTest("chatgpt-account-dialog") === dialog);
 assert(dialog.textContent?.includes("other@example.invalid")); assert.equal(toggle().getAttribute("aria-checked"), "true");
});

test("late global-control reply cannot overwrite a newer authoritative global value or leave control stuck", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(connected(), { consent: () => held.promise });
 await mount(); await click(button("Manage…")); await click(toggle());
 await act(async () => { f.push(connected(false)); f.push(connected(true)); });
 await act(async () => held.resolve(connected(false)));
 assert.equal(toggle().getAttribute("aria-checked"), "true"); assert.equal((toggle() as HTMLButtonElement).disabled, false);
 await click(button("Close")); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("late initial global draft reply cannot resurrect an older global value after a newer authoritative setting", async () => {
 const held = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { consent: () => held.promise });
 await mount(<><ChatGPTConnection /><ChatGPTBackgroundAccess provider="chatgpt" /></>);
 await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed")); await act(async () => f.complete());
 await act(async () => { f.push(connected(false)); f.push(connected(true)); });
 await act(async () => held.resolve(connected(false)));
 assert(!button("Enable background use")); assert(document.querySelector('[role="alert"]')); assert.equal((byTest("chatgpt-proceed") as HTMLButtonElement).disabled, false);
});

test("coalesced verified completion before late pending acknowledgement is reconciled once from fresh status", async () => {
 const ack = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { login: () => { f.calls.login.push(undefined); return ack.promise; } });
 await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
 await act(async () => f.complete()); assert.deepEqual(f.calls.consent, []);
 await act(async () => ack.resolve({ ...disconnected(), pending: true })); assert.deepEqual(f.calls.consent, [false]); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("canceled attempt's late reply cannot release a newer pending attempt or apply its old draft", async () => {
 const old = deferred<ChatGPTStatus>(); const f = fixture(disconnected(), { login: async () => { f.calls.login.push(undefined); if (f.calls.login.length === 1) return old.promise; f.push({ ...f.status, pending: true }); return f.status; } });
 await mount(); await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
 await click(button("Cancel", byTest("chatgpt-account-dialog"))); await begin(); await act(async () => old.resolve(connected(false)));
 assert((byTest("chatgpt-proceed") as HTMLButtonElement).disabled); assert.deepEqual(f.calls.consent, []);
 await act(async () => f.complete()); assert.deepEqual(f.calls.consent, []); assert.equal(f.status.allowBackgroundUse, true); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
});

test("real main/control bridge: immediate pending, actual cancellation, verified callback, then explicit global draft persistence", async () => {
 const require = createRequire(import.meta.url); const { createChatGPT, SCOPES } = require("../electron/chatgpt.cjs"); const { chatGPTControl } = require("../electron/chatgpt-ipc.cjs");
 const { privateKey, publicKey } = await generateKeyPair("RS256"); const jwk = { ...await exportJWK(publicKey), kid: "ui-fixture", alg: "RS256", use: "sig" };
 let saved: any = null, authorize!: URL, tokenCalls = 0; const listeners = new Set<() => void>();
 const service = createChatGPT({ store: { secure() {}, async read() { return saved; }, async write(s: any) { saved = structuredClone(s); } }, openExternal: async (url: string) => { authorize = new URL(url); }, onChange: () => { for (const cb of listeners) cb(); }, fetch: async (url: string, init: RequestInit) => {
  if (url.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
  assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token"); tokenCalls++;
  const form = init.body as URLSearchParams;
  const jwt = await new SignJWT({ nonce: authorize.searchParams.get("nonce"), email: "fixture@example.invalid" }).setProtectedHeader({ alg: "RS256", kid: "ui-fixture" }).setIssuer("https://auth.openai.com").setSubject("fixture-subject").setAudience(form.get("client_id")!).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: jwt, token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") });
 } });
 window.lh = { expandWindow() {}, chatgpt: { status: () => chatGPTControl({ op: "status" }, service), login: (id) => chatGPTControl({ op: "login", id }, service), cancel: () => chatGPTControl({ op: "cancel" }, service), select: (id) => chatGPTControl({ op: "select", id }, service), disconnect: (id) => chatGPTControl({ op: "disconnect", id }, service), logout: (id) => chatGPTControl({ op: "logout", id }, service), consent: (enabled) => chatGPTControl({ op: "consent", enabled }, service), onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); } } };
 try {
  await mount(); await begin(); assert.equal((await service.status()).pending, true); await click(button("Cancel", byTest("chatgpt-account-dialog"))); assert.equal((await service.status()).pending, false); assert.equal(tokenCalls, 0);
  await click(byTest("chatgpt-login")); await click(toggle()); await click(byTest("chatgpt-proceed"));
  const callback = new URL(authorize.searchParams.get("redirect_uri")!); callback.search = new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "fixture-code", client_id: "oaiapp_ui_fixture" }).toString();
  await act(async () => { const response = await originalFetch(callback); await response.text(); for (let i = 0; i < 100 && (saved.allowBackgroundUse !== false || (await service.status()).pending); i++) await new Promise((r) => setImmediate(r)); });
  assert.equal(tokenCalls, 1); assert.equal(saved.allowBackgroundUse, false); assert.equal(saved.registrations[0].background, undefined);
  assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]')); assert(button("Manage…"));
 } finally { await act(async () => service.close()); }
});

test("browser-only sign-in is disabled; foreground toolbar has no plan badge or background action", async () => {
 await mount(); assert((byTest("chatgpt-login") as HTMLButtonElement).disabled); await click(byTest("chatgpt-login")); assert(!document.querySelector('[data-testid="chatgpt-account-dialog"]'));
 await act(async () => root!.unmount()); host?.remove(); root = undefined;
 globalThis.fetch = async (input) => {
  if (input === "/api/models") return Response.json({ models: [], providers: [], slots: {}, defaults: {} });
  if (input === "/api/settings") return Response.json({ settings: { models: { strong: { model: { provider: "chatgpt", id: "gpt-5" } } } } });
  throw new Error(`unexpected fixture request ${input}`);
 };
 fixture(connected(false)); await mount(<ModelControl />); assert.match(byTest("stats-model").textContent!, /gpt/i);
 assert(!document.body.textContent?.includes("Using ChatGPT plan")); assert(!document.body.textContent?.includes("Enable background use"));
});
