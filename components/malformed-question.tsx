"use client";

import { Button } from "@/components/ui/button";
import { tr } from "@/src/core";

/** Recovery belongs to the transcript, never the answer dock. The caller
 * only offers it for the current saved malformed batch, not failed/aborted
 * generations or historical attempts. */
export function MalformedQuestion({ onRetry, disabled, reason }: {
	onRetry?: () => void;
	disabled?: boolean;
	reason?: string;
}) {
	return (
		<div data-testid="malformed-question" className="my-2 rounded-xl border border-dashed bg-card/60 p-3 text-sm text-muted-foreground">
			<p>{tr("无法显示此问题。", "This question could not be displayed.")}{onRetry ? tr("请重试，或发送消息以继续。", " Retry it or send a message to continue.") : ""}</p>
			{onRetry && <Button type="button" variant="outline" size="xs" className="mt-2" disabled={disabled}
				title={reason ?? tr("请模型重新生成一个问题。", "Requests a replacement from the model.")} data-testid="retry-malformed-question" onClick={onRetry}>
				{tr("重试问题", "Retry question")}
			</Button>}
			{reason && <p className="mt-1 text-xs">{reason}</p>}
		</div>
	);
}
