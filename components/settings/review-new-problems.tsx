"use client";
/**
 * The new-problems block (Settings > Review, 2026-11-03): every
 * never-practiced proposition, grouped by topic — a labeled graph region,
 * else Other (src/server/review.ts groupNewBacklog). Topics come sorted
 * by count, Other last, all expanded; problems in introduction order,
 * today's allowance badged "today". Rendered under the heatmap's day
 * detail from the same GET /api/review/schedule read.
 */

export type NewProblemView = { id: string; name: string; statement: string; today: boolean };
export type NewProblemTopicView = { id: string | null; label: string | null; problems: NewProblemView[] };

export function ReviewNewProblems({ topics }: { topics: NewProblemTopicView[] }) {
	const total = topics.reduce((n, topic) => n + topic.problems.length, 0);
	const today = topics.reduce((n, topic) => n + topic.problems.filter((p) => p.today).length, 0);
	return (
		<div data-testid="review-new-problems" className="flex flex-col gap-3 rounded-sm border border-border/60 p-3">
			<p className="text-xs uppercase tracking-widest text-muted-foreground" data-testid="review-new-problems-heading">
				New problems ({total}) · {today} today
			</p>
			{total === 0 && <p className="text-xs text-muted-foreground">No new problems.</p>}
			{topics.map((topic) => (
				<section key={topic.id ?? "other"} className="flex flex-col gap-2" data-testid="review-new-topic">
					<p className="text-xs text-foreground">
						{topic.label ?? "Other"} <span className="text-muted-foreground">({topic.problems.length})</span>
					</p>
					<ul className="flex flex-col gap-2">
						{topic.problems.map((problem) => (
							<li key={problem.id} className="flex min-w-0 items-start gap-2">
								<div className="min-w-0 flex-1">
									<p className="truncate font-prose text-(length:--lh-prose-size)">{problem.name}</p>
									<p className="truncate text-xs text-muted-foreground">{problem.statement}</p>
								</div>
								{problem.today && (
									<span
										data-testid="review-new-today"
										className="mt-0.5 shrink-0 rounded-full border border-border px-1.5 text-[11px] text-muted-foreground"
									>
										today
									</span>
								)}
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
