import type { LearningReferral, LearningResourceSearch } from "../core/learning-resources.ts";

// A small source-metadata fixture for the proposal; no textbook content copied.
// Provenance and scope: docs/learning-resources.md.
const TORQUE: LearningReferral = {
	title: "Torque, University Physics Volume 1",
	url: "https://openstax.org/books/university-physics-volume-1/pages/10-6-torque",
	provider: "openstax",
	section: "10.6 Torque: definition, force angle and moment arm",
	accessNote: "Original publisher section; current access and content must be checked on the source. English metadata; no language or regional-access guarantee. Link only; copying permission is not asserted.",
	activity: "Open section 10.6. Draw the pivot and force line for equal radial and perpendicular pushes at the same distance. Predict which produces more turning effect before calculating. Mark each perpendicular moment arm, then use r F sin(theta) to check your prediction. Explain why force magnitude alone is insufficient. If the source is blocked, ask the tutor for an alternative.",
	followUp: "After the learner returns, pose a fresh unaided problem comparing a smaller oblique force with a larger force whose line passes through the pivot. Use different magnitudes, distances and angles from earlier questions. Ask for a prediction, a sketch of the moment arm and a calculation without the source open. Collect the response before showing an answer or rubric. Assess the numerical result and moment-arm reasoning through the existing tools; reading completion is not mastery.",
};

const TOPICS = new Set(["torque", "moment arm", "force angle", "radial force"]);

/** Key-free, read-only source lookup. No network calls or learner-state writes. */
export function createLearningResourceSearch(): LearningResourceSearch {
	return async ({ query }) => {
		if (!query.trim() || query.length > 300) throw new Error("Use a topic of 1–300 characters");
		const topic = query.toLowerCase().replace(/^\s*what\s+(is|are)\s+/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
		const matched = TOPICS.has(topic);
		return {
			query,
			references: matched ? [{ ...TORQUE }] : [],
			warnings: matched ? [] : ["This prototype catalog covers torque only. Continue with the existing teaching/research tools; do not claim another source was found."],
			contentDownloaded: false,
			masteryUpdated: false,
		};
	};
}
