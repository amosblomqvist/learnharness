"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "./ui/button";
import { blurAfterPointerClick } from "./focus-hygiene";
import { copyText } from "./md-blocks";

/** Copy the whole response (its text parts, in order). A select-then-copy is
 *  the only other way and it loses the passage boundaries. The icon flips to
 *  a check for a beat. Shared by the transcript action row and the side-thread
 *  helper replies. */
export function CopyResponseButton({ getText }: { getText: () => string }) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timerRef.current), []);
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			data-testid="copy-response-button"
			aria-label={copied ? "Copied" : "Copy response"}
			title={copied ? "Copied" : "Copy response"}
			className={copied ? "text-muted-foreground" : "text-muted-foreground/40 hover:text-muted-foreground"}
			onClick={(event) => {
				blurAfterPointerClick(event);
				void copyText(getText()).then((ok) => {
					if (!ok) return;
					setCopied(true);
					window.clearTimeout(timerRef.current);
					timerRef.current = window.setTimeout(() => setCopied(false), 1500);
				});
			}}
		>
			{copied ? <CheckIcon aria-hidden className="size-3.5" /> : <CopyIcon aria-hidden className="size-3.5" />}
		</Button>
	);
}
