/**
 * Builds small EPUBs in memory for tests — no binary fixtures to keep in
 * sync. The shape follows a real EPUB 3 (mimetype first, container.xml →
 * OPF, nav document for the TOC); `encrypted` adds a META-INF/encryption.xml
 * naming a spine document, the shape store DRM leaves behind.
 */
import { strToU8, zipSync } from "fflate";

export interface FixtureChapter {
	title: string;
	/** Body XHTML (inside <body>). */
	body: string;
}

export function makeEpub(opts: {
	title?: string;
	author?: string;
	chapters: FixtureChapter[];
	encrypted?: boolean;
	/** EPUB 2 style: NCX TOC instead of a nav document. */
	ncx?: boolean;
}): Uint8Array {
	const { title = "Fixture Book", author = "A. Author", chapters } = opts;
	const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
		mimetype: [strToU8("application/epub+zip"), { level: 0 }],
		"META-INF/container.xml": strToU8(
			`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
				`<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
		),
	};
	const items = chapters.map((_, i) => `<item id="c${i + 1}" href="text/ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`);
	const toc = opts.ncx
		? `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`
		: `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`;
	files["OEBPS/content.opf"] = strToU8(
		`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
			`<metadata><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator></metadata>` +
			`<manifest>${toc}${items.join("")}</manifest>` +
			`<spine${opts.ncx ? ` toc="ncx"` : ""}>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join("")}</spine></package>`,
	);
	if (opts.ncx) {
		files["OEBPS/toc.ncx"] = strToU8(
			`<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>` +
				chapters
					.map((c, i) => `<navPoint id="n${i + 1}"><navLabel><text>${c.title}</text></navLabel><content src="text/ch${i + 1}.xhtml"/></navPoint>`)
					.join("") +
				`</navMap></ncx>`,
		);
	} else {
		files["OEBPS/nav.xhtml"] = strToU8(
			`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>` +
				`<nav epub:type="toc"><ol>${chapters.map((c, i) => `<li><a href="text/ch${i + 1}.xhtml">${c.title}</a></li>`).join("")}</ol></nav></body></html>`,
		);
	}
	chapters.forEach((c, i) => {
		files[`OEBPS/text/ch${i + 1}.xhtml`] = strToU8(
			`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${c.title}</title><style>p{}</style></head><body>${c.body}</body></html>`,
		);
	});
	if (opts.encrypted) {
		files["META-INF/encryption.xml"] = strToU8(
			`<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">` +
				`<enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>` +
				`<enc:CipherData><enc:CipherReference URI="OEBPS/text/ch1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`,
		);
	}
	return zipSync(files);
}
