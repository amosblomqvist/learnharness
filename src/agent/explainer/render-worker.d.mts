export declare const ExplainerWorkerReply: {
	readonly RENDERED: "explainer-rendered";
	readonly FAILED: "explainer-failed";
};
export type ExplainerWorkerReply = (typeof ExplainerWorkerReply)[keyof typeof ExplainerWorkerReply];

/** `root` is an empty folder the renderer may read (for example a <ve-flow> model or a plan's cited code). */
export type ExplainerWorkerRequest = { source: string; root: string; filename: string };

export type ExplainerWorkerResponse =
	| { type: typeof ExplainerWorkerReply.RENDERED; html: string; warnings: string[]; kit: boolean }
	| { type: typeof ExplainerWorkerReply.FAILED; errors: string[] };
