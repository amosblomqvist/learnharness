"use client";

import { useMemo } from "react";
import type { ChatGPTControlBridge, ChatGPTStatus, NativeSubscriptionControlBridge, NativeSubscriptionProviderId, NativeSubscriptionStatus } from "@/src/core";
import { useNotifyHub, type createNotifyHub } from "@/components/server-events";
import { tr, uiLanguage } from "@/src/core";

type Hub = ReturnType<typeof createNotifyHub> | null;
type Reply<T> = { value: T; browserAction?: string; error?: string };
const PATH = "/api/subscriptions";
const headers = { "Content-Type": "application/json", "x-learnharness-subscriptions": "1" };

async function status() {
	const response = await fetch(PATH, { headers, cache: "no-store" });
	if (!response.ok) throw new Error(tr("无法获取订阅状态。", "Subscription status is unavailable."));
	return response.json() as Promise<{ chatgpt: ChatGPTStatus; native: NativeSubscriptionStatus[] }>;
}
async function control<T>(providerId: string, op: string, fields: Record<string, unknown> = {}): Promise<Reply<T>> {
	const response = await fetch(PATH, { method: "POST", headers, body: JSON.stringify({ providerId, op, ...fields }) });
	if (!response.ok) throw new Error(tr("无法更改订阅连接。", "The subscription connection could not be changed."));
	return response.json() as Promise<Reply<T>>;
}
function onChange(hub: Hub, listener: () => void): () => void {
	const offEvent = hub?.subscribe("subscriptions-changed", listener);
	const offResync = hub?.onResync(listener);
	return () => { offEvent?.(); offResync?.(); };
}
/** Reserve the new tab synchronously in the click gesture. Only a one-use
 * same-origin action URL enters app JS; provider URLs remain in the owner.
 * Electron dev has no tabs: its narrow main-process opener performs this step. */
async function withBrowser<T>(action: () => Promise<Reply<T>>): Promise<T> {
	const external = window.lh?.subscriptionTransport === "web" ? window.lh.openSubscriptionBrowser : undefined;
	const tab = external ? null : window.open("about:blank", "_blank");
	if (!external && !tab) throw new Error(tr("请允许打开登录标签页，然后重试。", "Allow a sign-in tab to open, then try again."));
	if (tab) tab.opener = null;
	try {
		const reply = await action();
		if (reply.browserAction) {
			if (!/^\/api\/subscriptions\/browser\?id=[0-9a-f-]{36}$/.test(reply.browserAction)) throw new Error(tr("无效的登录操作。", "Invalid sign-in action."));
			if (external) await external(reply.browserAction);
			else if (tab && !tab.closed) tab.location.href = reply.browserAction;
			else throw new Error(tr("登录标签页已关闭。请取消后重试。", "The sign-in tab was closed. Cancel and try again."));
		} else tab?.close();
		return reply.value;
	} catch (error) { tab?.close(); throw error; }
}
export function createWebChatGPTBridge(hub: Hub): ChatGPTControlBridge {
	const call = async (op: string, fields?: Record<string, unknown>) => (await control<ChatGPTStatus>("chatgpt", op, fields)).value;
	return {
		status: async () => (await status()).chatgpt,
		login: (id) => withBrowser(() => control<ChatGPTStatus>("chatgpt", "login", { id })),
		cancel: () => call("cancel"), select: (id) => call("select", { id }),
		disconnect: (id) => call("disconnect", { id }), logout: (id) => call("logout", { id }),
		consent: (enabled) => call("consent", { enabled }),
		onChange: (listener) => onChange(hub, listener),
	};
}
export function createWebNativeBridge(hub: Hub): NativeSubscriptionControlBridge {
	const call = async (providerId: NativeSubscriptionProviderId, op: string, fields?: Record<string, unknown>) => { await control(providerId, op, fields); };
	return {
		status: async () => (await status()).native,
		login: (providerId, enabled) => call(providerId, "login", { enabled }),
		cancel: (providerId) => call(providerId, "cancel"),
		respond: (providerId, attemptId, promptId, value) => call(providerId, "respond", { attemptId, promptId, value }),
		open: async (providerId, attemptId, actionId) => { await withBrowser(() => control(providerId, "open", { attemptId, actionId })); },
		retry: (providerId) => call(providerId, "retry"), disconnect: (providerId) => call(providerId, "disconnect"),
		consent: (providerId, enabled) => call(providerId, "consent", { enabled }),
		onChange: (listener) => onChange(hub, listener),
	};
}
export function useChatGPTBridge(): ChatGPTControlBridge | undefined {
	const hub = useNotifyHub();
	return useMemo(() => typeof window === "undefined" ? undefined : window.lh?.subscriptionTransport !== "web" && window.lh?.chatgpt ? window.lh.chatgpt : createWebChatGPTBridge(hub), [hub]);
}
export function useNativeSubscriptionBridge(): NativeSubscriptionControlBridge | undefined {
	const hub = useNotifyHub();
	return useMemo(() => typeof window === "undefined" ? undefined : window.lh?.subscriptionTransport !== "web" && window.lh?.subscriptions ? window.lh.subscriptions : createWebNativeBridge(hub), [hub]);
}

/** Display text for the desktop bridge's connection errors. The Electron side keeps
 *  them English because src/agent matches them by regex; unknown text passes through. */
const CONNECTION_ERROR_TEXT: Record<string, string> = {
	"The saved connection could not be read or written safely. Reopen the app or reconnect after resolving the credential-file problem.": "无法安全读取或写入已保存的连接。请重新打开应用，或在解决凭据文件问题后重新连接。",
	"Sign-in did not complete. Try connecting again.": "登录未完成，请重新连接。",
	"The connection could not be refreshed. Retry or reconnect in Providers.": "无法刷新连接。请重试，或在“服务商”中重新连接。",
	"Sign-in cancelled.": "已取消登录。",
	"This subscription connection is unavailable. Reconnect or explicitly choose another connection.": "此订阅连接不可用。请重新连接，或明确选择其他连接。",
	"Background use is off for this connection. Automatic follow-up remains deferred in its queue.": "此连接已关闭后台使用。自动后续任务将继续在队列中等待。",
	"The connection or model catalog changed. Select an available model and retry.": "连接或模型列表已变化。请选择一个可用模型后重试。",
	"This sign-in action is no longer available.": "此登录操作已失效。",
	"Sign-in action expired.": "登录操作已过期。",
	"ChatGPT sign-in cancelled.": "已取消 ChatGPT 登录。",
	"ChatGPT sign-in timed out. Try again.": "ChatGPT 登录超时，请重试。",
	"ChatGPT credentials could not be read or saved. Check local file access, then reconnect before making requests.": "无法读取或保存 ChatGPT 凭据。请检查本地文件访问权限，然后重新连接后再发起请求。",
	"ChatGPT sign-in could not be verified. Select the intended saved account and try again.": "无法验证 ChatGPT 登录。请选择要使用的已保存账号后重试。",
	"ChatGPT plan permission is missing. Reconnect and authorize ChatGPT plan use.": "缺少 ChatGPT 套餐权限。请重新连接并授权使用 ChatGPT 套餐。",
	"This ChatGPT connection is disconnected. Reconnect in Providers.": "此 ChatGPT 连接已断开。请在“服务商”中重新连接。",
	"ChatGPT background use is off in this app. Enable Allow background use for all ChatGPT accounts in Providers, or explicitly select an API-key model for that workload.": "此应用已关闭 ChatGPT 后台使用。请在“服务商”中为所有 ChatGPT 账号开启“允许后台使用”，或为该任务明确选择一个使用 API 密钥的模型。",
	"The ChatGPT account model catalog is unavailable. Retry the connection; no API-key fallback was used.": "ChatGPT 账号的模型列表不可用。请重试连接；未回退到 API 密钥。",
	"The ChatGPT session expired. Reconnect in Providers.": "ChatGPT 会话已过期。请在“服务商”中重新连接。",
	"ChatGPT could not be reached. Check your connection and try again.": "无法连接到 ChatGPT。请检查网络连接后重试。",
	"A ChatGPT sign-in is already pending.": "已有一个 ChatGPT 登录正在进行中。",
	"ChatGPT sign-in is unavailable in browser-only mode.": "仅浏览器模式下无法使用 ChatGPT 登录。",
	"ChatGPT sign-in failed. Try again; no API-key fallback was used.": "ChatGPT 登录失败，请重试；未回退到 API 密钥。",
};

export function connectionErrorText<T extends string | null | undefined>(message: T): T | string {
	return (message && uiLanguage() === "zh" && CONNECTION_ERROR_TEXT[message]) || message;
}
