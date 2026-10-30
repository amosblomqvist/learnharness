import React, { Fragment } from "react";
import {
	File,
	FileArchive,
	FileAudio,
	FileCode,
	FileImage,
	FileSpreadsheet,
	FileText,
	FileVideo,
} from "lucide-react";
import type { InlineChunk } from "@/components/bidi-text";
import { LITERAL_TEXT, filePathLabel, parseFilePaths } from "@/src/core";

function fileIcon(label: string) {
	const extension = label.split(".").at(-1)?.toLowerCase();
	if (/^(png|jpe?g|gif|webp|svg|bmp|tiff?|avif|heic)$/.test(extension ?? "")) return FileImage;
	if (/^(mp3|wav|ogg|flac|m4a|aac)$/.test(extension ?? "")) return FileAudio;
	if (/^(mp4|mov|webm|mkv|avi)$/.test(extension ?? "")) return FileVideo;
	if (/^(zip|gz|tar|bz2|xz|7z|rar)$/.test(extension ?? "")) return FileArchive;
	if (/^(csv|tsv|xlsx?|ods)$/.test(extension ?? "")) return FileSpreadsheet;
	if (/^(js|jsx|ts|tsx|py|rb|rs|go|c|cpp|h|java|json|html|css|sh|yaml|yml)$/.test(extension ?? "")) return FileCode;
	if (/^(pdf|txt|md|mdx|rtf|docx?|odt|tex|epub)$/.test(extension ?? "")) return FileText;
	return File;
}

export interface FilePathChipProps {
	path: string;
	/** Editors can make the chip atomic; transcript renderers can omit this. */
	contentEditable?: false;
	className?: string;
}

/** Pure presentation: no links, open actions, HTML injection or path probing.
 *  Always left-to-right, so the icon stays left of the name inside a
 *  right-to-left field as it does in the sent message. */
export function FilePathChip({ path, contentEditable, className }: FilePathChipProps) {
	const label = filePathLabel(path);
	const Icon = fileIcon(label);
	return (
		<span
			role="img"
			aria-label={path}
			title={path}
			dir="ltr"
			contentEditable={contentEditable}
			className={`inline-flex max-w-full items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 align-middle text-sm${className ? ` ${className}` : ""}`}
		>
			<Icon aria-hidden="true" className="size-3.5 shrink-0" />
			<span className="min-w-0 truncate">{label}</span>
		</span>
	);
}

/** Ordinary learner text stays ordinary text; only quoted paths become chips. */
export function PathText({ text }: { text: string }) {
	return (
		<>
			{parseFilePaths(text).map((part) => (
				<Fragment key={part.start}>
					{part.kind === "path" ? <FilePathChip path={part.path} /> : part.text}
				</Fragment>
			))}
		</>
	);
}

/** One line of learner text as `BidiText` chunks: text parts stay text, and
 *  each quoted path is one chip that reads as a single left-to-right letter, so
 *  it stays whole inside the run it sits in and its letters never set the
 *  line's direction. */
export function filePathChunks(line: string): InlineChunk[] {
	return parseFilePaths(line).map((part) => {
		if (part.kind === "text") return { text: part.text };
		const chip = <FilePathChip key={part.start} path={part.path} />;
		return { text: LITERAL_TEXT, element: { node: chip, own: () => chip } };
	});
}
