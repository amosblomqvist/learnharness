import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";

export const CHATGPT_PROVIDER_ID = "openai-chatgpt";
export const CHATGPT_SOURCE_PROVIDER_ID = "openai";

export interface ChatGPTBrokerStatus {
	available: boolean;
	connected: boolean;
	error?: string;
}

interface TokenResponse {
	accessToken: string;
	expires: number;
}

class BrokerError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

function brokerConfig(): { url: string; secret: string } | undefined {
	const url = process.env.LH_CHATGPT_BROKER_URL;
	const secret = process.env.LH_CHATGPT_BROKER_SECRET;
	if (!url || !secret) return undefined;
	return { url: url.replace(/\/$/, ""), secret };
}

export function chatGPTBrokerConfigured(): boolean {
	return brokerConfig() !== undefined;
}

async function brokerRequest<T>(pathname: string, method: "GET" | "POST", signal?: AbortSignal): Promise<T> {
	const config = brokerConfig();
	if (!config) throw new BrokerError("ChatGPT login is available only in the LearnHarness desktop app.");
	const timeout = AbortSignal.timeout(30_000);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(`${config.url}${pathname}`, {
		method,
		headers: { authorization: `Bearer ${config.secret}` },
		cache: "no-store",
		signal: requestSignal,
	});
	if (!response.ok) throw new BrokerError(`ChatGPT credential broker returned ${response.status}.`, response.status);
	return (await response.json()) as T;
}

export async function getChatGPTBrokerStatus(signal?: AbortSignal): Promise<ChatGPTBrokerStatus> {
	if (!brokerConfig()) return { available: false, connected: false };
	try {
		return await brokerRequest<ChatGPTBrokerStatus>("/v1/status", "GET", signal);
	} catch (error) {
		return {
			available: true,
			connected: false,
			error: error instanceof Error ? error.message : "ChatGPT credential broker is unavailable.",
		};
	}
}

async function getToken(signal?: AbortSignal): Promise<TokenResponse | undefined> {
	try {
		return await brokerRequest<TokenResponse>("/v1/token", "POST", signal);
	} catch (error) {
		if (error instanceof BrokerError && error.status === 401) return undefined;
		throw error;
	}
}

/**
 * The Electron process owns OAuth refresh and encrypted persistence. This
 * store projects its short-lived access token into pi-ai without ever
 * persisting the token in the Next server or exposing it to the renderer.
 */
export class ChatGPTBrokerCredentialStore implements CredentialStore {
	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		if (providerId !== CHATGPT_SOURCE_PROVIDER_ID || !brokerConfig()) return undefined;
		const token = await getToken(options?.signal);
		if (!token) return undefined;
		return {
			type: "oauth",
			access: token.accessToken,
			refresh: "electron-broker-managed",
			expires: token.expires,
		};
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const status = await getChatGPTBrokerStatus(options?.signal);
		return status.connected ? [{ providerId: CHATGPT_SOURCE_PROVIDER_ID, type: "oauth" }] : [];
	}

	async modify(
		providerId: string,
		transform: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const current = await this.read(providerId, options);
		const next = await transform(current);
		if (next !== undefined && next !== current) {
			throw new Error("ChatGPT OAuth credentials are managed by the Electron process.");
		}
		return current;
	}

	async delete(): Promise<void> {
		throw new Error("Disconnect ChatGPT from the desktop settings.");
	}
}
