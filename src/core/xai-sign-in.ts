export const XAI_SIGN_IN_LABEL = "Sign in with SuperGrok or X Premium";

export type XaiSignedInNotice =
	| { kind: "key-unused" }
	| { kind: "refresh-failed" }
	| { kind: "reauth-denied" }
	| { kind: "reauth-expired" }
	| { kind: "reauth-failed" };

export type XaiSignInAction = "start" | "cancel" | "sign-out";

export type XaiSignInView =
	| { phase: "signed-out"; actions: readonly ["start"] }
	| {
			phase: "pending";
			userCode: string;
			verificationUri: string;
			expiresAt: number;
			actions: readonly ["cancel"];
	  }
	| { phase: "denied"; actions: readonly ["start"] }
	| { phase: "expired"; actions: readonly ["start"] }
	| { phase: "failed"; reason: "unreadable-file" | "provider"; actions: readonly ["start"] }
	| {
			phase: "signed-in";
			notice: XaiSignedInNotice | null;
			actions: readonly ["start", "sign-out"];
	  };

export type XaiSignInCommand = { type: "status" } | { type: "start" } | { type: "cancel" } | { type: "sign-out" };

export type XaiSignInPost = Exclude<XaiSignInCommand, { type: "status" }>;

export function parseXaiSignInCommand(input: unknown): XaiSignInPost | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const type = (input as { type?: unknown }).type;
	if (type === "start" || type === "cancel" || type === "sign-out") return { type };
	return null;
}

export function parseHttpsUrl(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	return url.href;
}

type DropActions<T> = T extends unknown ? Omit<T, "actions"> : never;
export type XaiSignInCopy = DropActions<XaiSignInView>;

export function xaiSignInLine(view: XaiSignInCopy): string | null {
	switch (view.phase) {
		case "signed-out":
			return null;
		case "pending":
			return "Enter this code in the xAI page. This screen updates when you approve.";
		case "denied":
			return "xAI denied the sign-in. Try again, or paste an API key.";
		case "expired":
			return "That code expired. Start sign-in again, or paste an API key.";
		case "failed":
			return view.reason === "unreadable-file"
				? "The xAI sign-in file could not be read. It was left unchanged."
				: "xAI sign-in failed. Try again, or paste an API key.";
		case "signed-in":
			if (view.notice === null) return null;
			switch (view.notice.kind) {
				case "key-unused":
					return "An API key is saved. xAI uses this sign-in until you sign out.";
				case "refresh-failed":
					return "xAI sign-in could not be refreshed. Sign in again, or sign out to use an API key.";
				case "reauth-denied":
					return "The new sign-in was denied. The current sign-in is unchanged.";
				case "reauth-expired":
					return "That code expired. The current sign-in is unchanged.";
				case "reauth-failed":
					return "The new sign-in failed. The current sign-in is unchanged.";
			}
	}
}
