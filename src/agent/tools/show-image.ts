import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { loadLearnerImage } from "./learner-image.ts";
import type { ShowImageDetails } from "../../core/contracts.ts";

/**
 * show_image (issue #363): put one of the learner's image files into the
 * lesson as-is — the instant, model-free twin of `visual` with an image.
 * Teacher only, always on like the learner-filesystem set.
 *
 * The picture lands in the record only (`details` → the tool part's
 * output → ImageCard). The teacher's result is ONE text line (owner
 * decision): the image is never re-sent on later turns; read is how the
 * teacher looks at it.
 */

const showImageInput = Type.Object({
	path: Type.String({ minLength: 1, description: "Path to the learner's image file (relative or absolute)" }),
	caption: Type.Optional(Type.String({ description: "One short line shown under the image" })),
});

export const showImageTool: AgentTool<typeof showImageInput> = {
	name: "show_image",
	label: "show_image",
	description:
		"Show one of the learner's image files (jpg, png, gif, webp, bmp) in the lesson as-is, with an optional caption. " +
		"Instant. The result only confirms what was shown — the image is not sent back to you; use read to look at it. " +
		"To draw marks on the image, call visual with its path instead.",
	parameters: showImageInput,
	execute: serverExecute("show_image", showImageInput, async ({ path, caption }, { signal }): Promise<ImageFileResult> => {
		const image = await loadLearnerImage(path, signal);
		const trimmed = caption?.trim();
		const details: ShowImageDetails = {
			path: image.path,
			...(trimmed ? { caption: trimmed } : {}),
			mimeType: image.mimeType,
			data: image.data,
			width: image.width,
			height: image.height,
		};
		return { text: `Shown to the learner: ${image.path} (${image.width}×${image.height}).`, details };
	}),
};
