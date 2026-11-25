/** The invert disc (owner round, 2026-10-07): the half-filled circle that
 *  IS the invert toggle's sliding disc. Hand-rolled because lucide's
 *  Contrast leaves its half-moon unfilled (fill="none" by default) — the
 *  owner's catch: the filled side must be ACTUALLY filled. Same geometry
 *  as lucide's (circle r10 + left half-moon), the half carries
 *  fill="currentColor". */
export function InvertDiscIcon({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
		>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 18a6 6 0 0 0 0-12v12z" fill="currentColor" stroke="none" />
		</svg>
	);
}
