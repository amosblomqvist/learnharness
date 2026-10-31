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
import { filePathLabel, parseFilePaths } from "@/src/core";

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

/** Pure presentation: no links, open actions, HTML injection or path probing. */
export function FilePathChip({ path, contentEditable, className }: FilePathChipProps) {
	const label = filePathLabel(path);
	const Icon = fileIcon(label);
	return (
		<span
			role="img"
			aria-label={path}
			title={path}
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
