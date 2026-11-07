import assert from "node:assert/strict";
import { it } from "node:test";
import {
	emptySourceOrganization,
	applyOrganizationAction,
	parseSourceOrganization,
	type OrganizationAction,
} from "../src/core/source-organization.ts";
import { libraryRows } from "../src/core/tag-library.ts";
it("uses existing placements and descendant tag memberships together, deduplicating search results", () => {
	const ids = new Set(["one", "two", "import"]);
	let state = emptySourceOrganization();
	const change = (a: Exclude<OrganizationAction, { action: "rename-source" }>, id = "unused") => {
		state = applyOrganizationAction(state, a, ids, { id, createdAt: "now" });
	};
	change({ action: "create-folder", name: "School", parentId: null }, "school");
	change({ action: "create-folder", name: "Semester 1", parentId: "school" }, "sem");
	change({ action: "move", kind: "source", id: "one", parentId: "sem" });
	change({ action: "create-tag", name: "MATH286", parentId: "sem", color: "#114488" }, "course");
	change({ action: "tag-sources", sourceIds: ["one", "two", "import"], add: ["course"], remove: [] });
	const sources = [...ids].map(id => ({
		id,
		kind: id === "import" ? ("notes" as const) : ("chat" as const),
		label: id,
		createdAt: "now",
	}));
	const notes = [
		{
			chatId: "one",
			sessionTitle: "One",
			mode: "final" as const,
			sectionId: "basis",
			heading: "Diagonalization",
			text: "An eigenbasis exists.",
		},
	];
	const library = () => ({ organization: state, sources, notes });
	assert.equal(libraryRows(library(), { kind: "folder", id: "school" }, "").length, 3);
	assert.equal(
		libraryRows(library(), { kind: "tag", id: "course" }, "eigenbasis")[0]!.matches[0]?.sectionId,
		"basis",
	);
	assert.throws(() => change({ action: "delete-folder", id: "sem" }));
	assert.throws(() => change({ action: "tag-sources", sourceIds: ["one", "missing"], remove: ["course"], add: [] }));
	assert.deepEqual(state.placements.one?.tagIds, ["course"]);
	change({ action: "update-tag", id: "course", name: "Math", parentId: null });
	assert.equal(libraryRows(library(), { kind: "folder", id: "school" }, "").length, 1);
	change({ action: "delete-tag", id: "course" });
	assert.deepEqual(parseSourceOrganization(state).placements.one, { folderId: "sem", tagIds: [] });
});
