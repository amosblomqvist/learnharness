"use client";

import { PencilIcon } from "lucide-react";

/**
 * The edit control on the learner's LAST message (issue #321): a pencil in
 * the "You" row, hidden until the row is hovered (the row carries `group`)
 * or the button takes keyboard focus. Clicking it asks the page to rewind:
 * the running turn stops, the message and everything after it go, and the
 * text returns to the composer.
 */
export function EditMessageButton({ onEdit }: { onEdit: () => void }) {
	return (
		<button
			type="button"
			data-testid="edit-message"
			aria-label="Edit message"
			title="Edit message"
			onClick={onEdit}
			className="rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
		>
			<PencilIcon className="size-3" />
		</button>
	);
}
