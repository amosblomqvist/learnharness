import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Random lowercase hex that also works on the phone's plain-HTTP direct
 *  link (see src/core/random-id.ts). */
export { randomHex } from "@/src/core/random-id.ts";
