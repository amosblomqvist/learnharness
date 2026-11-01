import { timingSafeEqual } from "node:crypto";

/** The Android shell gives only its private WebView this per-launch cookie.
 * Guard HTML/RSC as well as APIs: server-rendered pages contain local data. */
export function androidRequestAuthorized(headers: Headers, env: Record<string, string | undefined> = process.env): boolean {
	if (env.LH_ANDROID !== "1") return true;
	const secret = env.LH_ANDROID_API_SECRET;
	const origin = env.LH_ANDROID_ORIGIN;
	if (!secret || !/^[a-f0-9]{64}$/.test(secret) || !origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return false;
	if (headers.get("host") !== new URL(origin).host) return false;
	if (headers.get("sec-fetch-site") === "cross-site") return false;
	if (headers.has("origin") && headers.get("origin") !== origin) return false;
	const values = (headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith("lh_android="));
	if (values.length !== 1) return false;
	const supplied = values[0]!.slice("lh_android=".length);
	if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
	return timingSafeEqual(Buffer.from(supplied), Buffer.from(secret));
}
