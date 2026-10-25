import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { imageFileName, isRasterDataUrl, rasterMimeOf } from "../src/core/images.ts";
import { ImageGallery, galleryItemsFromBlocks } from "../components/image-gallery.tsx";
import { ToolCallCard } from "../components/artifacts/tool-call-card.tsx";
import { UserMessageParts } from "../components/user-message-parts.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { SessionMermaidContext } from "../components/session-overlay.tsx";
import { useImageLightbox } from "../components/image-lightbox.tsx";

const B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";
const png = { type: "image", data: B64, mimeType: "image/png" };
const URL_PNG = `data:image/png;base64,${B64}`;

describe("ImageGallery", () => {
	it("accepts only raster data URLs", () => {
		assert.ok(isRasterDataUrl(URL_PNG));
		assert.ok(!isRasterDataUrl("data:image/svg+xml;base64," + B64));
		assert.ok(!isRasterDataUrl("https://example.com/a.png"));
		assert.ok(!isRasterDataUrl("javascript:alert(1)"));
	});
	it("drops unknown mime and malformed blocks", () => {
		const items = galleryItemsFromBlocks([
			png,
			{ type: "image", data: B64, mimeType: "image/svg+xml" },
			{ type: "image", data: "<script>", mimeType: "image/png" },
			{ type: "text", text: "x" },
			null,
		]);
		assert.equal(items.length, 1);
		assert.equal(items[0]!.url, URL_PNG);
		assert.deepEqual(galleryItemsFromBlocks(undefined), []);
	});
	it("renders src, generic alt and caption; falls back to download without an opener", () => {
		const html = renderToStaticMarkup(<ImageGallery items={[{ url: URL_PNG, caption: "a.pdf · p. 2" }]} showCaptions />);
		assert.match(html, /src="data:image\/png;base64,/);
		assert.match(html, /alt="a\.pdf · p\. 2"/);
		assert.match(html, /a\.pdf · p\. 2<\/figcaption>|Download/);
		assert.match(html, /download="image\.png"/);
		assert.doesNotMatch(renderToStaticMarkup(<ImageGallery items={[{ url: URL_PNG }]} />), /Pasted/);
		assert.match(renderToStaticMarkup(<ImageGallery items={[{ url: URL_PNG }]} />), /alt="Image"/);
	});
	it("renders a button when the session provides openImage", () => {
		const html = renderToStaticMarkup(
			<SessionMermaidContext.Provider value={{ openMermaid() {}, openFigure() {}, openImage() {} }}>
				<ImageGallery items={[{ url: URL_PNG }]} />
			</SessionMermaidContext.Provider>,
		);
		assert.match(html, /<button[^>]*aria-label="View image in full"/);
		assert.match(html, /cursor-zoom-in/);
	});
	it("renders nothing for unsafe items", () => {
		assert.equal(renderToStaticMarkup(<ImageGallery items={[{ url: "https://x/y.png" }]} />), "");
	});
});

describe("ToolCallCard images", () => {
	const part = (tool: string, extra: object) =>
		({ type: `tool-${tool}`, toolCallId: "c", state: "output-available", ...extra }) as never;
	it("shows the gallery with null details, after the collapsed trace", () => {
		const html = renderToStaticMarkup(
			<ToolCallCard part={part("pdf_view", { input: { path: "n.pdf", page: 3 }, output: null, images: [png] })} />,
		);
		assert.match(html, /data-testid="tool-call-card"/);
		assert.match(html, /data-testid="image-gallery"/);
		assert.match(html, /n\.pdf · p\. 3/);
		assert.ok(html.indexOf("tool-call-card") < html.indexOf("image-gallery"));
	});
	it("read shows images; no images leaves the card unchanged", () => {
		assert.match(renderToStaticMarkup(<ToolCallCard part={part("read", { input: { path: "a.png" }, images: [png] })} />), /image-gallery/);
		assert.doesNotMatch(renderToStaticMarkup(<ToolCallCard part={part("read", { input: { path: "a.md" }, output: { text: "hi" } })} />), /image-gallery/);
	});
	it("pdf_view is registered", () => {
		assert.equal(artifactRenderers.pdf_view, ToolCallCard);
		assert.equal(artifactRenderers.read, ToolCallCard);
	});
});

describe("UserMessageParts", () => {
	it("keeps text/image order and the user-image testid", () => {
		const html = renderToStaticMarkup(
			<UserMessageParts
				onOpenImage={() => {}}
				parts={[
					{ type: "text", id: "a", text: "before" },
					{ type: "image", id: "b", url: URL_PNG, alt: "Pasted" },
					{ type: "text", id: "c", text: "after" },
				]}
			/>,
		);
		assert.ok(html.indexOf("before") < html.indexOf("user-image"));
		assert.ok(html.indexOf("user-image") < html.indexOf("after"));
	});
});

describe("useImageLightbox", () => {
	it("is closed initially (lightbox null)", () => {
		let r: ReturnType<typeof useImageLightbox> | undefined;
		function H() {
			r = useImageLightbox();
			return null;
		}
		renderToStaticMarkup(<H />);
		assert.equal(r!.lightbox, null);
		assert.equal(typeof r!.open, "function");
	});
});

it("shared raster helpers retain MIME types and download filenames", () => {
	for (const [mime, ext] of [["png", "png"], ["jpeg", "jpg"], ["gif", "gif"], ["webp", "webp"]]) {
		const url = "data:image/" + mime + ";base64,AAAAAAAAAAAAAAAA";
		assert.equal(rasterMimeOf(url), "image/" + mime);
		assert.equal(imageFileName(url), "image." + ext);
	}
	assert.equal(rasterMimeOf("data:image/svg+xml;base64,AAAAAAAAAAAAAAAA"), null);
});
