/**
 * The on-device dictation model catalog: 29 speech models plus the shared
 * language detector, with the display helpers the Settings list needs.
 * Ported from pi-voice src/catalog.ts and catalog/catalog.json (MIT, Copyright
 * (c) 2026 Earendil Works contributors): https://github.com/earendil-works/pi-voice
 *
 * Browser-safe: pure data and string logic. The model bytes are fetched by
 * src/server/local-stt, only from the repository/revision/filename named here.
 */
import catalog from "./local-stt-catalog.json" with { type: "json" };
import { canonicalLanguage, languageIdentity, resolveModelLanguage } from "./local-stt-languages.ts";

export { canonicalLanguage, languageIdentity, resolveModelLanguage };

export type CatalogModel = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly repository: string;
	readonly revision: string;
	/** The model's own licence id from its card (e.g. "apache-2.0", "cc-by-4.0", "other"). */
	readonly license: string;
	readonly family: string;
	readonly parameters: string | null;
	readonly languages: readonly string[];
	readonly capabilities: {
		readonly languageDetection: boolean;
	};
	readonly filename: string;
	/** Exact file size in bytes. */
	readonly size: number;
	readonly sha256: string;
};

export const CATALOG_MODELS: readonly CatalogModel[] = catalog.models;

/** Detects the spoken language for models that cannot do it themselves. */
export const LANGUAGE_DETECTION_MODEL: CatalogModel = catalog.languageDetector;

export function getCatalogModel(id: string): CatalogModel | undefined {
	return CATALOG_MODELS.find((model) => model.id === id);
}

export function isCatalogModelId(value: unknown): value is string {
	return typeof value === "string" && getCatalogModel(value) !== undefined;
}

/** True for the ids the model store can download: the catalog plus the language detector. */
export function isDownloadableModelId(value: unknown): value is string {
	return isCatalogModelId(value) || value === LANGUAGE_DETECTION_MODEL.id;
}

/** The catalog entry or the detector for a downloadable id. */
export function getDownloadableModel(id: string): CatalogModel | undefined {
	return getCatalogModel(id) ?? (id === LANGUAGE_DETECTION_MODEL.id ? LANGUAGE_DETECTION_MODEL : undefined);
}

/** The URL of a model file. The only place a download URL is built: never from a request. */
export function catalogModelUrl(model: CatalogModel): string {
	const path = model.filename.split("/").map(encodeURIComponent).join("/");
	return `https://huggingface.co/${model.repository}/resolve/${model.revision}/${path}`;
}

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

export function displayLanguage(language: string): string {
	// ASR catalogs conventionally use zh for Mandarin and list Cantonese as yue.
	// Make that spoken-language distinction explicit without losing the familiar
	// umbrella term users look for.
	if (canonicalLanguage(language) === "zh") return "Mandarin (Chinese)";
	try {
		return languageNames.of(language) ?? language;
	} catch {
		return language;
	}
}

export function modelMatchesLanguage(model: Pick<CatalogModel, "languages">, language: string): boolean {
	return resolveModelLanguage(model, language) !== undefined;
}

function preferredLanguageMatchCount(model: CatalogModel, preferredLanguages: readonly string[]): number {
	return [...new Set(preferredLanguages.map(languageIdentity))].filter((language) =>
		modelMatchesLanguage(model, language),
	).length;
}

/** Order models: the most preferred languages first, then downloaded ones, then by name.
 * The catalog carries no editorial rank, so names only settle models without a benchmark. */
export function rankCatalogModels(
	models: readonly CatalogModel[],
	preferredLanguages: readonly string[] = [],
	isDownloaded: (model: CatalogModel) => boolean = () => false,
): CatalogModel[] {
	return [...models].sort(
		(left, right) =>
			preferredLanguageMatchCount(right, preferredLanguages) - preferredLanguageMatchCount(left, preferredLanguages) ||
			Number(isDownloaded(right)) - Number(isDownloaded(left)) ||
			left.name.localeCompare(right.name),
	);
}

/** What a catalog search runs against. Languages and capabilities are left out on
 * purpose: a long haystack made short queries match nearly everything. */
export function catalogModelSearchText(model: CatalogModel): string {
	return [model.id, model.name, model.family, model.parameters ?? ""].join(" ").toLowerCase();
}

export function formatBinarySize(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GiB`;
	return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

const CATALOG_LANGUAGE_IDENTITIES: ReadonlySet<string> = new Set(
	CATALOG_MODELS.flatMap((model) => model.languages.map(languageIdentity)),
);

/** True when some catalog model can transcribe this language (exact code or its identity,
 * so "fil" and "tl", "nb" and "no" both count). */
export function isCatalogLanguage(value: unknown): value is string {
	return typeof value === "string" && CATALOG_LANGUAGE_IDENTITIES.has(languageIdentity(value));
}
