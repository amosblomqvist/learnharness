import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChainTableBody } from "../components/chain-table.tsx";
import { DeleteSourceBody } from "../components/delete-source-dialog.tsx";
import { sourceNameMatches } from "../components/source-folder-tree.tsx";
import type { GraphNode, SourceDirectory } from "../src/core/index.ts";
const directory: SourceDirectory = {
	organization: { version: 1, folders: [
		{ id: "f1", name: "Course", parentId: null, createdAt: "2026-10-30" },
		{ id: "f2", name: "Week", parentId: "f1", createdAt: "2026-10-30" },
		{ id: "empty", name: "Empty", parentId: null, createdAt: "2026-10-30" },
	], placements: { notes: { folderId: "f2", name: "Named book" } } },
	sources: [
		{ id: "chat", kind: "chat", label: "Not yet extracted", createdAt: "2026-10-29" },
		{ id: "notes", kind: "notes", label: "Named book", filePath: "Course/Week/original.pdf", createdAt: "2026-10-29" },
	],
};
const nodes: GraphNode[] = ["a", "b"].map((id) => ({ id, name: id, statement: id, aliases: [], provenance: [{ chatId: "notes", messageId: "m" }], createdAt: "2026-10-29" }));
const base: Parameters<typeof ChainTableBody>[0] = {
	nodes: [], chains: [], sessions: {}, fileSources: {}, query: "", onQuery() {}, sort: { col: "name", dir: 1 }, onSort() {}, selection: new Set(),
	expandedClusters: new Set(), expandedChains: new Set(), onToggleCluster() {}, onToggleChain() {}, onToggleNodes() {}, onClear() {}, onDelete() {}, onClose() {},
	directory, onOrganizationChange: async () => {},
};
const render = (props: Partial<typeof base> = {}) => renderToStaticMarkup(<ChainTableBody {...base} {...props} />);

it("source inventory includes unextracted chats and zero-graph imported books; only real folders use folder icons", () => {
	const html = render({ expandedClusters: new Set(["f1", "f2"]) });
	assert.match(html, /Not yet extracted/); assert.match(html, /Named book/); assert.doesNotMatch(html, /original.pdf/);
	assert.match(html, /lucide-book/); assert.match(html, /lucide-folder/);
	assert.match(html, /data-testid="add-source-folder"/); assert.match(html, /data-testid="source-root-drop"/);
	assert.doesNotMatch(html, /Top level/);
	assert.match(html, /data-testid="folder-thread-f1"[^>]*style="left:37px"/);
	assert.match(html, /data-testid="folder-thread-f2"[^>]*style="left:73px"/);
	assert.match(html, /data-testid="source-separator-notes"[^>]*style="left:1px"/);
	assert.match(html, /data-testid="folder-separator-f2"[^>]*style="left:37px"/);
	assert.match(html, /data-testid="folder-icon-f2"[^>]*aria-expanded="true"/);
	assert.match(html, /data-testid="source-icon-notes"[^>]*aria-expanded="false"/);
	assert.match(html, /data-testid="cluster-group-notes"[^>]*style="margin-left:72px"/);
	assert.doesNotMatch(html, /No matching chains/);
});
it("nested folders aggregate unique graph member counts, keep three-column sorting and expose root placement", () => {
	const html = render({ nodes, expandedClusters: new Set(["f1", "f2", "notes"]), selectedSources: new Set(["notes"]), selectedFolders: new Set(["f1", "f2"]) });
	assert.match(html, /data-testid="folder-checkbox-f1"[^>]*checked/); assert.match(html, /data-testid="folder-checkbox-f2"[^>]*checked/);
	assert.match(html, /data-testid="sort-name"/); assert.match(html, /data-testid="sort-props"/); assert.match(html, /data-testid="sort-created"/);
	assert.match(html, /lucide-book-open/); assert.match(html, /draggable="true"/);
});
it("collapsed folders have no dangling rail, while expanded folders reuse the source/chain bracket grammar", () => {
	assert.doesNotMatch(render(), /data-testid="folder-thread-/);
	const html = render({ expandedClusters: new Set(["f1"]) });
	assert.match(html, /data-testid="folder-thread-f1"[^>]*bottom-\[8px\][^>]*top-\[23px\]/);
	assert.doesNotMatch(html, /data-testid="folder-thread-f2"/);
});
it("re-import record dates do not change existing graph groups' Created dates", () => {
	const newer = { ...directory, sources: directory.sources.map((s) => s.id === "notes" ? { ...s, createdAt: "2099-01-01" } : s) };
	const html = render({ nodes, directory: newer, expandedClusters: new Set(["f1", "f2"]) });
	assert.doesNotMatch(html, /2099-01-01/);
	assert.match(html, /2026-10-29/);
});
it("folder selection means all its graph contents even while a search hides some rows", () => {
	const html = render({ selectMode: true, nodes, query: "a", expandedClusters: new Set(["f1", "f2"]), selection: new Set(["a"]) });
	const checkbox = html.split('data-testid="folder-checkbox-f1"')[0]!.split("<input").at(-1)!;
	assert.doesNotMatch(checkbox, /checked/);
	assert.match(html, />2<\/span>/, "full folder count, not only matched node a");
});
it("empty folder selection enables Delete outside practice, and practice never selects organizational folders", () => {
	const html = render({ selectedFolders: new Set(["empty"]) });
	assert.match(html, /1 folder/); assert.match(html, /data-testid="chain-delete"/);
	const practice = render({ selectMode: true });
	assert.match(practice, /data-testid="folder-checkbox-empty"[^>]*disabled|disabled=""[^>]*data-testid="folder-checkbox-empty"/);
	assert.doesNotMatch(practice, /data-testid="chain-delete"/);
});
it("ordinary browsing offers source/folder checks, including empty ones, but only practice offers fine-grained node checks", () => {
	const html = render({ nodes, expandedClusters: new Set(["f1", "f2", "notes"]), expandedChains: new Set(["a", "b"]) });
	assert.doesNotMatch(html, /data-testid="(?:prop|chain)-checkbox-/);
	for (const id of ["cluster-checkbox-chat", "cluster-checkbox-notes", "folder-checkbox-f1", "folder-checkbox-f2", "folder-checkbox-empty"]) {
		const tag = html.match(new RegExp(`<input[^>]*data-testid="${id}"[^>]*>`))?.[0];
		assert.ok(tag, id); assert.doesNotMatch(tag, /disabled/, id);
	}
	const practice = render({ selectMode: true, nodes, expandedClusters: new Set(["f1", "f2", "notes"]), expandedChains: new Set(["a", "b"]) });
	assert.match(practice, /data-testid="chain-checkbox-a"/); assert.match(practice, /data-testid="prop-checkbox-a"/);
});
it("source and folder names are searchable without needing any extracted nodes", () => {
	assert.equal(sourceNameMatches(directory, "notes", "Named book", "Course"), true);
	assert.equal(sourceNameMatches(directory, "notes", "Named book", "Named"), true);
	assert.equal(sourceNameMatches(directory, "notes", "Named book", "xyzxyz"), false);
	assert.match(render({ query: "Not yet" }), /Not yet extracted/);
});
it("source confirmation explains shared-node survival and makes conversation deletion an unchecked opt-in", () => {
	const html = renderToStaticMarkup(<DeleteSourceBody sources={directory.sources} folders={[]} deleteSessions={false} onDeleteSessions={() => {}} busy={false} failure="" onClose={() => {}} onRun={() => {}} />);
	assert.match(html, /Knowledge supported by other sources survives/); assert.match(html, /can be extracted again/);
	assert.match(html, /graph contributions and extraction coverage are cleared/); assert.match(html, /Also delete the 1 selected session/);
	assert.doesNotMatch(html.match(/<input[^>]+>/)?.[0] ?? "", /checked/);
});
