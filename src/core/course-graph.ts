import type { CourseLesson } from "./contracts.ts";

/**
 * The course's lesson DEPENDENCY GRAPH — pure, browser-safe operations
 * (courses plan, 2026-10-30). Lessons carry their prerequisite ids; the
 * structure must be a DAG with unique ids and known endpoints. Problems
 * are returned as agent-readable strings (the planner's submit seam feeds
 * them straight back as a retry message; routes return them as 400s).
 */

/** Every structural problem with the lesson set; [] = valid. */
export function lessonGraphProblems(lessons: readonly CourseLesson[]): string[] {
	const problems: string[] = [];
	const ids = new Set<string>();
	for (const l of lessons) {
		if (typeof l.id !== "string" || l.id.trim() === "") problems.push("Every lesson needs a non-empty id.");
		else if (ids.has(l.id)) problems.push(`Duplicate lesson id "${l.id}" — lesson ids must be unique.`);
		ids.add(l.id);
	}
	for (const l of lessons) {
		for (const p of l.prerequisites) {
			if (p === l.id) problems.push(`Lesson "${l.id}" lists itself as a prerequisite.`);
			else if (!ids.has(p)) problems.push(`Lesson "${l.id}" has unknown prerequisite "${p}".`);
		}
	}
	if (problems.length === 0) {
		const cycle = findCycle(lessons);
		if (cycle) problems.push(`Prerequisites form a cycle: ${cycle.join(" → ")}.`);
	}
	return problems;
}

/** One cycle as a closed id path, or null when the graph is acyclic. */
function findCycle(lessons: readonly CourseLesson[]): string[] | null {
	const prereqs = new Map(lessons.map((l) => [l.id, l.prerequisites]));
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];
	const visit = (id: string): string[] | null => {
		const s = state.get(id);
		if (s === "done") return null;
		if (s === "visiting") return [...stack.slice(stack.indexOf(id)), id];
		state.set(id, "visiting");
		stack.push(id);
		for (const p of prereqs.get(id) ?? []) {
			if (!prereqs.has(p)) continue;
			const found = visit(p);
			if (found) return found;
		}
		stack.pop();
		state.set(id, "done");
		return null;
	};
	for (const l of lessons) {
		const found = visit(l.id);
		if (found) return found;
	}
	return null;
}

/** Would adding the edge `prerequisite → lesson` create a cycle (or a self-loop)? */
export function wouldCycle(lessons: readonly CourseLesson[], prerequisite: string, lesson: string): boolean {
	if (prerequisite === lesson) return true;
	// A cycle appears iff `lesson` is already a (transitive) prerequisite of `prerequisite`.
	const prereqs = new Map(lessons.map((l) => [l.id, l.prerequisites]));
	const seen = new Set<string>();
	const todo = [prerequisite];
	while (todo.length > 0) {
		const id = todo.pop()!;
		if (id === lesson) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		todo.push(...(prereqs.get(id) ?? []));
	}
	return false;
}

/** Dependency order (Kahn), ties broken by target date then title. Lessons
 *  caught in a cycle (never for a valid course) are appended at the end. */
export function topoOrder<T extends CourseLesson>(lessons: readonly T[]): T[] {
	const byId = new Map(lessons.map((l) => [l.id, l]));
	const indegree = new Map(lessons.map((l) => [l.id, l.prerequisites.filter((p) => byId.has(p)).length]));
	const dependents = new Map<string, string[]>();
	for (const l of lessons) {
		for (const p of l.prerequisites) {
			if (byId.has(p)) dependents.set(p, [...(dependents.get(p) ?? []), l.id]);
		}
	}
	const cmp = (a: T, b: T) => a.targetDate.localeCompare(b.targetDate) || a.title.localeCompare(b.title);
	const ready = lessons.filter((l) => indegree.get(l.id) === 0);
	const out: T[] = [];
	while (ready.length > 0) {
		ready.sort(cmp);
		const next = ready.shift()!;
		out.push(next);
		for (const d of dependents.get(next.id) ?? []) {
			const n = indegree.get(d)! - 1;
			indegree.set(d, n);
			if (n === 0) ready.push(byId.get(d)!);
		}
	}
	if (out.length < lessons.length) {
		const placed = new Set(out.map((l) => l.id));
		out.push(...lessons.filter((l) => !placed.has(l.id)).sort(cmp));
	}
	return out;
}

/** Lesson ids that directly depend on `id`. */
export function dependentsOf(lessons: readonly CourseLesson[], id: string): string[] {
	return lessons.filter((l) => l.prerequisites.includes(id)).map((l) => l.id);
}

/** A slug for a new lesson id, unique among `taken`. */
export function lessonSlug(title: string, taken: ReadonlySet<string>): string {
	const base =
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "lesson";
	let id = base;
	for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
	return id;
}
