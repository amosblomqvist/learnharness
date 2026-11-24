import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildSessionTree,
	flattenSessionTree,
	graphFolderCheck,
	graphFolderIds,
	graphFolderVisibleIds,
	toggleGraphFolder,
	type SessionTreeNode,
	type SourceOrganization,
} from "../src/core/index.ts";

type S = { id: string; title: string; updatedAt: string; kind?: "teach" | "practice" };
const s = (id: string, title: string, day: number): S => ({ id, title, updatedAt: `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z` });
const folder = (id: string, name: string, parentId: string | null = null) => ({ id, name, parentId, createdAt: "2026-01-01T00:00:00.000Z" });
const org = (folders: ReturnType<typeof folder>[], placements: Record<string, string | null>): SourceOrganization => ({
	version: 1,
	folders,
	placements: Object.fromEntries(Object.entries(placements).map(([id, folderId]) => [id, { folderId }])),
});
const shape = (nodes: SessionTreeNode<S>[]): unknown[] => nodes.map((n) => n.type === "session" ? n.session.id : { [n.folder.id]: shape(n.children) });

describe("buildSessionTree", () => {
	const organization = org(
		[folder("f-phys", "Physics"), folder("f-optics", "Optics", "f-phys"), folder("f-empty-b", "Beta"), folder("f-empty-a", "alpha"), folder("f-notes", "Notes only")],
		{ s1: "f-phys", s2: "f-optics", n1: "f-notes" },
	);
	const sessions = [s("s3", "Unfiled recent", 9), s("s2", "Lenses", 7), s("s4", "Unfiled old", 2), s("s1", "Forces", 5)];

	it("folders lead every level by activity, folders without sessions follow A–Z, then sessions by activity", () => {
		const tree = buildSessionTree(sessions, organization, { query: "" });
		assert.deepEqual(shape(tree), [
			{ "f-phys": [{ "f-optics": ["s2"] }, "s1"] },
			{ "f-empty-a": [] }, { "f-empty-b": [] }, { "f-notes": [] },
			"s3",
			"s4",
		]);
		const phys = tree[0];
		assert.ok(phys?.type === "folder" && phys.activity === "2026-01-07T00:00:00.000Z", "activity includes subfolders");
	});

	it("a type filter hides folders whose sessions it hides; folders holding no sessions show under every filter", () => {
		const tree = buildSessionTree(sessions, organization, { query: "", include: (x) => x.id !== "s2" });
		assert.deepEqual(shape(tree), [
			{ "f-phys": ["s1"] },
			{ "f-empty-a": [] }, { "f-empty-b": [] }, { "f-notes": [] },
			"s3", "s4",
		], "Optics (only a filtered-out session) hides; empty and notes-only folders stay");
		const nested = org([folder("p", "Parent"), folder("e", "Empty", "p"), folder("q", "Practice only", "p")], { x: "q" });
		const only = [{ ...s("x", "drill", 3), kind: "practice" as const }];
		assert.deepEqual(shape(buildSessionTree(only, nested, { query: "", include: (x) => x.kind !== "practice" })),
			[{ p: [{ e: [] }] }], "a parent stays to hold its shown empty subfolder");
		assert.deepEqual(shape(buildSessionTree(only, org([folder("q", "Practice only")], { x: "q" }), { query: "", include: (x) => x.kind !== "practice" })), []);
	});

	it("search hides folders without matches, empty ones included", () => {
		assert.deepEqual(shape(buildSessionTree(sessions, organization, { query: "forces" })), [{ "f-phys": ["s1"] }]);
	});

	it("search keeps the tree, title-only matching, ranked by best match at every level", () => {
		const list = [s("a", "xenon notes", 9), s("b", "Lens basics", 1), s("c", "lens", 3)];
		const o = org([folder("f", "Optics")], { b: "f", c: "f" });
		const tree = buildSessionTree(list, o, { query: "lens" });
		// "lens" (exact) beats "Lens basics" (prefix) within the folder.
		assert.deepEqual(shape(tree), [{ f: ["c", "b"] }]);
		const o2 = org([folder("f", "Optics"), folder("g", "Geometry")], { b: "f", c: "g" });
		const tree3 = buildSessionTree([...list, s("d", "lens", 2)], o2, { query: "lens" });
		assert.deepEqual(shape(tree3), [{ g: ["c"] }, { f: ["b"] }, "d"], "folders lead even when an unfiled session matches better; folders rank by best match");
		const tree2 = buildSessionTree(list, o, { query: "Optics" });
		assert.deepEqual(shape(tree2), [], "folder names are not searched — titles only, as before");
	});

	it("without an organization the list is the flat activity order", () => {
		assert.deepEqual(shape(buildSessionTree(sessions, undefined, { query: "" })), ["s3", "s2", "s1", "s4"]);
	});

	it("flatten hides closed folders' contents; the walk order is the visible session rows", () => {
		const tree = buildSessionTree(sessions, organization, { query: "" });
		const closed = flattenSessionTree(tree, () => false).flatMap((r) => r.type === "session" ? [r.session.id] : []);
		assert.deepEqual(closed, ["s3", "s4"]);
		const opened = flattenSessionTree(tree, () => true);
		assert.deepEqual(opened.flatMap((r) => r.type === "session" ? [`${r.session.id}@${r.depth}`] : []), ["s2@2", "s1@1", "s3@0", "s4@0"]);
	});
});

describe("graph folder filter", () => {
	const organization = org(
		[folder("phys", "Physics"), folder("optics", "Optics", "phys"), folder("math", "Math"), folder("practice", "Practice only")],
		{ teachA: "phys", teachB: "optics", mathS: "math", prac: "practice", notes1: "math" },
	);
	const graphSources = new Set(["teachA", "teachB", "mathS", "notes1", "unfiled"]);

	it("lists only folders whose subtree holds graph material", () => {
		assert.deepEqual([...graphFolderIds(organization, graphSources)].sort(), ["math", "optics", "phys"]);
	});

	it("ticking a folder includes its listed subfolders, which can be unticked", () => {
		const listed = graphFolderIds(organization, graphSources);
		let selected = toggleGraphFolder(organization, new Set(), "phys", true, listed);
		assert.deepEqual([...selected].sort(), ["optics", "phys"]);
		selected = toggleGraphFolder(organization, selected, "optics", false, listed);
		assert.deepEqual([...selected], ["phys"]);
		assert.deepEqual(graphFolderCheck(organization, selected, "phys", listed), { checked: true, indeterminate: true });
	});

	it("shows propositions with ANY source in a ticked folder; complete chains only; null = whole graph", () => {
		const listed = graphFolderIds(organization, graphSources);
		const nodeSources = { p1: ["teachA"], shared: ["mathS", "teachA"], m1: ["mathS"], u1: ["unfiled"], orphan: [] as string[] };
		const impLinks = [
			{ id: "arg_full", premises: ["p1", "shared"], conclusion: "p1" },
			{ id: "arg_partial", premises: ["p1", "m1"], conclusion: "shared" },
		];
		const base = { organization, listed, propositionIds: Object.keys(nodeSources), nodeSources, impLinks };
		assert.equal(graphFolderVisibleIds({ ...base, selected: new Set() }), null);
		const phys = graphFolderVisibleIds({ ...base, selected: new Set(["phys"]) })!;
		assert.deepEqual([...phys].sort(), ["arg_full", "p1", "shared"], "shared shows via its physics source; m1/u1/orphan hidden; partial chain not drawn");
		const math = graphFolderVisibleIds({ ...base, selected: new Set(["math"]) })!;
		assert.deepEqual([...math].sort(), ["m1", "shared"]);
		assert.equal(graphFolderVisibleIds({ ...base, selected: new Set(["deleted"]) }), null, "unlisted/deleted choices never blank the graph");
	});
});
