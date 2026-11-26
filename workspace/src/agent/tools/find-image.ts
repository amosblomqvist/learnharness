import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { formatCandidates, searchCommons } from "./commons.ts";

/**
 * find_image: search Wikimedia Commons for a real picture or illustration
 * (anatomy, apparatus, organisms, places, historical drawings). It returns
 * up to five candidates as TEXT (title, short description, size, license,
 * author). Nothing reaches the learner until the model picks one and calls
 * show_image({ commons }), and no image bytes ever reach the model, which is
 * what keeps it cheap. Toggleable (TOGGLEABLE_TOOLS), on by default; teacher
 * and practitioner.
 */

const findImageInput = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 200, description: "A few plain English search words for the picture, e.g. \"mitochondrion diagram\" or \"steam locomotive cutaway\"" }),
});

export const findImageTool: AgentTool<typeof findImageInput> = {
	name: "find_image",
	label: "find_image",
	description:
		"Search Wikimedia Commons (free-licensed photos, drawings and diagrams) for a picture of a real-world thing. " +
		"Returns up to five candidates as text — nothing is shown yet and you never see the pictures. " +
		"Pick the candidate whose description fits and call show_image with commons set to its exact title.",
	parameters: findImageInput,
	execute: serverExecute("find_image", findImageInput, async ({ query }, { signal }) => {
		const trimmed = query.trim();
		return formatCandidates(trimmed, await searchCommons(trimmed, signal));
	}),
};
