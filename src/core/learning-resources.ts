/** Optional referral port. Reading a source is not an assessment result. */
export interface LearningResourceQuery {
	query: string;
}

export interface LearningReferral {
	title: string;
	url: string;
	provider: string;
	section: string;
	accessNote: string;
	activity: string;
	followUp: string;
}

export interface LearningResourceResult {
	query: string;
	references: LearningReferral[];
	warnings: string[];
	contentDownloaded: false;
	masteryUpdated: false;
}

export type LearningResourceSearch = (input: LearningResourceQuery) => Promise<LearningResourceResult>;
