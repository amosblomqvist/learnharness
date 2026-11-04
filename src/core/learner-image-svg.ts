import type { ImageSnapshot } from "./contracts/chat.ts";

export const LEARNER_IMAGE_HREF = "learner-image";

/** Substitute only an actual image element's href, never text/comments/CDATA. */
export function embedLearnerImage(svg: string, image: ImageSnapshot): string {
	const uri = `data:${image.mimeType};base64,${image.data}`;
	return svg.replace(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<\/?[a-zA-Z](?:[^<>"']|"[^"]*"|'[^']*')*>/g, (token) => {
		if (!/^<image(?=[\s/>])/.test(token)) return token;
		// Consume whole attribute values so href-like text inside another value cannot match.
		return token.replace(/(\s+)([^\s=/>]+)(\s*=\s*)("[^"]*"|'[^']*')/g, (match, space: string, name: string, equals: string, value: string) => {
			if ((name !== "href" && name !== "xlink:href") || value.slice(1, -1) !== LEARNER_IMAGE_HREF) return match;
			return `${space}${name}${equals}${value[0]}${uri}${value[0]}`;
		});
	});
}
