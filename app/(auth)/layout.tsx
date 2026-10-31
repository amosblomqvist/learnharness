/**
 * Auth layout (mobile-web, 2026-10-29): login, setup and invite acceptance.
 * Deliberately outside the app shell — no sidebar, no docks, no activity bus.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
	return (
		<main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
			<div className="w-full max-w-sm">{children}</div>
		</main>
	);
}
