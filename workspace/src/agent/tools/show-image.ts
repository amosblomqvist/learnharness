import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { learnerImageFromBytes, loadLearnerImage } from "./learner-image.ts";
import { fetchCommonsImage } from "./commons.ts";
import type { ShowImageDetails, WebImageDetails } from "../../core/contracts.ts";
import type { ChatStore } from "../../core/ports.ts";

/**
 * show_image (issue #363): put a picture into the lesson as-is — the
 * instant, model-free twin of `visual` with an image. Teacher and
 * practitioner, always on like the learner-filesystem set.
 *
 * Two sources: one of the learner's image files (`path`), or a Wikimedia
 * Commons file that find_image listed (`commons`). The commons input exists
 * only while the find_image toggle is on, since it reaches the internet.
 *
 * The picture lands in the record only (`details` → the tool part's
 * output → ImageCard). The model's result is ONE text line (owner
 * decision): the image is never re-sent on later turns; read is how the
 * teacher looks at a local file.
 */

const caption = Type.Optional(Type.String({ description: "One short line shown under the image" }));
const localInput = Type.Object({
	path: Type.String({ minLength: 1, description: "Path to the learner's image file (relative or absolute)" }),
	caption,
});
const withCommonsInput = Type.Object({
	path: Type.Optional(Type.String({ minLength: 1, description: "Path to the learner's image file (relative or absolute). Give path or commons, not both." })),
	commons: Type.Optional(Type.String({ minLength: 1, description: "A Wikimedia Commons file title exactly as find_image listed it (\"File:…\"). Give path or commons, not both." })),
	caption,
});

const LOCAL_DESCRIPTION =
	"Show one of the learner's image files (jpg, png, gif, webp, bmp) in the lesson as-is, with an optional caption. " +
	"Instant. The result only confirms what was shown — the image is not sent back to you; use read to look at it. " +
	"To draw marks on the image, call visual with its path instead. Visual results display automatically: do not repeat a newly delivered result. " +
	"Show a picture again only when resurfacing it meaningfully helps the current explanation. Local paths follow File access settings; use ls to discover allowed folders.";
const COMMONS_DESCRIPTION =
	" Or set commons to a Wikimedia Commons title that find_image listed, to show that free-licensed picture with its attribution. " +
	"You cannot see a commons picture: choose it from find_image's description, and teach from what that description says.";

export interface ShowImageToolContext {
	chatId: string;
	chatStore: Pick<ChatStore, "saveImageSnapshot">;
	/** The find_image toggle: true adds the commons input. */
	commons?: boolean;
}

export function createShowImageTool(ctx: ShowImageToolContext): AgentTool<typeof withCommonsInput> {
	const commons = ctx.commons === true;
	const parameters = commons ? withCommonsInput : localInput;
	return {
		name: "show_image",
		label: "show_image",
		description: commons ? LOCAL_DESCRIPTION + COMMONS_DESCRIPTION : LOCAL_DESCRIPTION,
		parameters: parameters as typeof withCommonsInput,
		execute: serverExecute("show_image", withCommonsInput, async (input, { signal }): Promise<ImageFileResult> => {
			const trimmed = input.caption?.trim();
			const title = commons ? input.commons?.trim() : undefined;
			if (title && input.path) throw new Error("Give either path or commons, not both.");
			if (title) {
				const { bytes, meta } = await fetchCommonsImage(title, signal);
				const image = await learnerImageFromBytes(bytes, meta.title, signal);
				ctx.chatStore.saveImageSnapshot(ctx.chatId, image.snapshotId, image);
				const details: WebImageDetails = {
					source: "commons",
					...meta,
					...(trimmed ? { caption: trimmed } : {}),
					mimeType: image.mimeType,
					snapshotId: image.snapshotId,
					width: image.width,
					height: image.height,
				};
				return { text: `Shown to the learner: ${meta.title} from Wikimedia Commons (${image.width}×${image.height}), with its attribution.`, details };
			}
			if (!input.path) throw new Error(commons ? "Give path (a local image) or commons (a find_image title)." : "Give the path of the learner's image.");
			const image = await loadLearnerImage(input.path, signal);
			ctx.chatStore.saveImageSnapshot(ctx.chatId, image.snapshotId, image);
			const details: ShowImageDetails = {
				path: image.path,
				...(trimmed ? { caption: trimmed } : {}),
				mimeType: image.mimeType,
				snapshotId: image.snapshotId,
				width: image.width,
				height: image.height,
			};
			return { text: `Shown to the learner: ${image.path} (${image.width}×${image.height}).`, details };
		}),
	};
}
