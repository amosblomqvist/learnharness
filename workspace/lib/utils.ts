import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Random lowercase hex. Unlike crypto.randomUUID, getRandomValues also
 *  works on the phone's plain-HTTP direct link (not a secure context). */
export function randomHex(bytes = 16): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
