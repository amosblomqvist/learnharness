import type { AuthEvent } from "@earendil-works/pi-ai";
import { bindXaiAuthHooks, piModels, type XaiAuthHooks } from "../agent/models.ts";
import {
	parseHttpsUrl,
	xaiSignInLine,
	type XaiSignInCommand,
	type XaiSignInView,
	type XaiSignedInNotice,
} from "../core/xai-sign-in.ts";
import { credentialStore, replaceUnreadableXai } from "../store/credentials.ts";
import { keyValue } from "./keys.ts";

const REFRESH_FAILURES = new Set([
	"OAuth refresh failed for xai",
	"OAuth auth derivation failed for xai",
	"OAuth refresh returned a token that expires too soon for xai",
]);

type Attempt =
	| { kind: "idle" }
	| { kind: "pending"; userCode: string; verificationUri: string; expiresAt: number; abort: AbortController }
	| { kind: "denied" }
	| { kind: "expired" }
	| { kind: "failed" };

interface Runtime {
	generation: number;
	refreshFailed: boolean;
	login: Promise<void> | null;
	attempt: Attempt;
	tail: Promise<void>;
}

const RUNTIME_KEY = Symbol.for("lh.xaiSignIn");

function runtime(): Runtime {
	const g = globalThis as Record<symbol, Runtime | undefined>;
	if (!g[RUNTIME_KEY]) {
		g[RUNTIME_KEY] = {
			generation: 0,
			refreshFailed: false,
			login: null,
			attempt: { kind: "idle" },
			tail: Promise.resolve(),
		};
	}
	return g[RUNTIME_KEY];
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const rt = runtime();
	const run = rt.tail.then(task, task);
	rt.tail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function signedInNotice(attempt: Attempt): XaiSignedInNotice | null {
	const rt = runtime();
	if (rt.refreshFailed) return { kind: "refresh-failed" };
	if (attempt.kind === "denied") return { kind: "reauth-denied" };
	if (attempt.kind === "expired") return { kind: "reauth-expired" };
	if (attempt.kind === "failed") return { kind: "reauth-failed" };
	if (keyValue("XAI_API_KEY") !== undefined) return { kind: "key-unused" };
	return null;
}

function project(): XaiSignInView {
	const facts = credentialStore.facts("xai");
	if (facts.health === "unreadable") {
		return { phase: "failed", reason: "unreadable-file", actions: ["start"] as const };
	}
	const attempt = runtime().attempt;
	if (attempt.kind === "pending") {
		return {
			phase: "pending",
			userCode: attempt.userCode,
			verificationUri: attempt.verificationUri,
			expiresAt: attempt.expiresAt,
			actions: ["cancel"] as const,
		};
	}
	if (facts.oauth) {
		return { phase: "signed-in", notice: signedInNotice(attempt), actions: ["start", "sign-out"] as const };
	}
	if (attempt.kind === "denied") return { phase: "denied", actions: ["start"] as const };
	if (attempt.kind === "expired") return { phase: "expired", actions: ["start"] as const };
	if (attempt.kind === "failed") return { phase: "failed", reason: "provider", actions: ["start"] as const };
	return { phase: "signed-out", actions: ["start"] as const };
}

function isCancel(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("Login cancelled");
}

function classify(message: string): Attempt {
	if (message.includes("authorization was denied")) return { kind: "denied" };
	if (message.includes("device code expired")) return { kind: "expired" };
	return { kind: "failed" };
}

function defer(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function publishDevice(gen: number, abort: AbortController, event: AuthEvent, publish: () => void): void {
	if (runtime().generation !== gen || event.type !== "device_code") return;
	const uri = parseHttpsUrl(event.verificationUri);
	const seconds = event.expiresInSeconds;
	if (!uri || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
		runtime().attempt = { kind: "failed" };
		abort.abort();
		publish();
		return;
	}
	runtime().attempt = {
		kind: "pending",
		userCode: event.userCode,
		verificationUri: uri,
		expiresAt: Date.now() + seconds * 1000,
		abort,
	};
	publish();
}

function runLogin(gen: number, abort: AbortController, publish: () => void): Promise<void> {
	const handle: { promise?: Promise<void> } = {};
	handle.promise = (async () => {
		try {
			await piModels().login("xai", "oauth", {
				signal: abort.signal,
				prompt: () => Promise.reject(new Error("xAI sign-in does not prompt")),
				notify: (event) => publishDevice(gen, abort, event, publish),
			});
			const current = runtime();
			if (current.generation !== gen) return;
			current.attempt = { kind: "idle" };
			current.refreshFailed = false;
		} catch (error) {
			const current = runtime();
			if (current.generation !== gen) return;
			const kind = current.attempt.kind;
			if (kind === "failed" || kind === "denied" || kind === "expired") return;
			if (abort.signal.aborted || isCancel(error)) return;
			const message = error instanceof Error ? error.message : String(error);
			current.attempt = classify(message);
		} finally {
			publish();
			const current = runtime();
			if (current.login === handle.promise) current.login = null;
		}
	})();
	return handle.promise;
}

async function start(): Promise<XaiSignInView> {
	return enqueue(async () => {
		const rt = runtime();
		const healthyPending =
			credentialStore.facts("xai").health !== "unreadable" &&
			rt.attempt.kind === "pending" &&
			rt.attempt.expiresAt > Date.now();
		if (healthyPending) return project();
		if (rt.attempt.kind === "pending") rt.attempt.abort.abort();
		rt.generation += 1;
		const gen = rt.generation;
		const previous = rt.login;
		rt.attempt = { kind: "idle" };
		if (previous) await previous.catch(() => {});
		if (credentialStore.facts("xai").health === "unreadable") await replaceUnreadableXai();
		const abort = new AbortController();
		const gate = defer();
		const loginPromise = runLogin(gen, abort, gate.resolve);
		rt.login = loginPromise;
		await gate.promise;
		return project();
	});
}

async function cancel(): Promise<XaiSignInView> {
	return enqueue(async () => {
		const rt = runtime();
		if (rt.attempt.kind === "pending") rt.attempt.abort.abort();
		rt.generation += 1;
		rt.attempt = { kind: "idle" };
		return project();
	});
}

async function signOut(): Promise<XaiSignInView> {
	return enqueue(async () => {
		const rt = runtime();
		if (rt.attempt.kind === "pending") rt.attempt.abort.abort();
		rt.generation += 1;
		const login = rt.login;
		if (login) await login.catch(() => {});
		rt.attempt = { kind: "idle" };
		rt.refreshFailed = false;
		if (credentialStore.facts("xai").health !== "unreadable") await piModels().logout("xai");
		return project();
	});
}

export function xaiSignIn(command: XaiSignInCommand): Promise<XaiSignInView> {
	switch (command.type) {
		case "status":
			return enqueue(async () => project());
		case "start":
			return start();
		case "cancel":
			return cancel();
		case "sign-out":
			return signOut();
	}
}

const hooks: XaiAuthHooks = {
	onProviderError(providerId, rawMessage) {
		if (providerId !== "xai" || !REFRESH_FAILURES.has(rawMessage)) return undefined;
		void enqueue(async () => {
			runtime().refreshFailed = true;
		});
		return xaiSignInLine({ phase: "signed-in", notice: { kind: "refresh-failed" } }) ?? undefined;
	},
	onProviderSuccess(providerId) {
		if (providerId !== "xai") return;
		void enqueue(async () => {
			runtime().refreshFailed = false;
		});
	},
};

bindXaiAuthHooks(hooks);
