/**
 * buildSidebarFolderView turns the kind-filtered chat list plus the
 * shared organization snapshot into the rendered tree — folder ordering,
 * chat placement (practice chats always at the root), the search reveal
 * rules and the visible-chat order the keyboard walk follows.
 * nextKbdChat/enterKbdChat pin the walk; SidebarFolderTree's SSR markup
 * pins aria-expanded, role=group nesting and the data attributes.
 * Same tsx classic-JSX shim as render-sidebar.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	buildSidebarFolderView,
	enterKbdChat,
	nextKbdChat,
	SidebarFolderTree,
	type SidebarTreeNode,
} from "../components/sidebar-folder-tree.tsx";
import type { ChatListItem } from "../src/core/index.ts";
import { chat, STAMP, type TestOrg } from "./helpers/sidebar-fixtures.ts";

type FolderNode = Extract<SidebarTreeNode, { kind: "folder" }>;

/* The shared fixture: two nested folders (Algebra → Maps), a notes-only
 * folder, an empty folder, and two case/numeric ordering probes; chats in
 * Algebra, in Maps, at the root three ways (no placement / folderId null /
 * unknown folder id), and a practice chat placed inside Algebra. */
const FOLDERS: TestOrg["folders"] = [
	{ id: "alg", name: "Algebra", parentId: null, createdAt: STAMP },
	{ id: "maps", name: "Maps", parentId: "alg", createdAt: STAMP },
	{ id: "notes", name: "Notes only", parentId: null, createdAt: STAMP },
	{ id: "empty", name: "Empty", parentId: null, createdAt: STAMP },
	{ id: "f10", name: "folder 10", parentId: null, createdAt: STAMP },
	{ id: "f2", name: "Folder 2", parentId: null, createdAt: STAMP },
];

const CHATS: ChatListItem[] = [
	chat("c_alg1", { title: "Linear maps intro" }),
	chat("c_maps1", { title: "Eigenstuff" }),
	chat("c_maps2", { title: "Diagonalization" }),
	chat("c_root1", { title: "Loose chat" }),
	chat("c_null", { title: "Rooted chat" }),
	chat("c_orphan", { title: "Lost placement" }),
	chat("c_prac", { title: "Practice: integrals", kind: "practice" }),
];

const ORG: TestOrg = {
	folders: FOLDERS,
	placements: {
		c_alg1: { folderId: "alg" },
		c_maps1: { folderId: "maps" },
		c_maps2: { folderId: "maps" },
		c_null: { folderId: null },
		c_orphan: { folderId: "ghost" },
		c_prac: { folderId: "alg" },
		// c_root1 carries no placement entry at all.
	},
};

const label = (n: SidebarTreeNode) => (n.kind === "folder" ? `F:${n.folder.name}` : `C:${n.chat.id}`);

function allFolders(nodes: readonly SidebarTreeNode[]): FolderNode[] {
	return nodes.flatMap((n) => (n.kind === "folder" ? [n, ...allFolders(n.children)] : []));
}

function allChatIds(nodes: readonly SidebarTreeNode[]): string[] {
	return nodes.flatMap((n) => (n.kind === "chat" ? [n.chat.id] : allChatIds(n.children)));
}

describe("buildSidebarFolderView — flat list (organization null)", () => {
	it("no query: flat chat nodes in input order, visibleChatIds equals input order", () => {
		const chats = [chat("a"), chat("b"), chat("c")];
		const view = buildSidebarFolderView(chats, null, "", new Set(), new Set());
		assert.deepEqual(view.roots.map(label), ["C:a", "C:b", "C:c"]);
		assert.deepEqual(view.visibleChatIds, ["a", "b", "c"]);
	});

	it("query: only fuzzy title matches, descending score, stable on ties", () => {
		const chats = [
			chat("mid", { title: "Linear algebra" }),
			chat("top", { title: "Al" }),
			chat("tie1", { title: "Alphabet" }),
			chat("tie2", { title: "Alpha" }),
			chat("none", { title: "Beta" }),
		];
		const view = buildSidebarFolderView(chats, null, "al", new Set(), new Set());
		assert.deepEqual(view.roots.map(label), ["C:top", "C:tie1", "C:tie2", "C:mid"]);
		assert.deepEqual(view.visibleChatIds, ["top", "tie1", "tie2", "mid"]);
	});
});

describe("buildSidebarFolderView — placement and ordering", () => {
	it("no query: root level lists folders first in collator order, then root chats in input order", () => {
		const view = buildSidebarFolderView(CHATS, ORG, "", new Set(), new Set());
		assert.deepEqual(view.roots.map(label), [
			"F:Algebra",
			"F:Empty",
			"F:Folder 2",
			"F:folder 10",
			"F:Notes only",
			"C:c_root1",
			"C:c_null",
			"C:c_orphan",
			"C:c_prac",
		]);
	});

	it("no query: equal folder names are ordered by id", () => {
		const org: TestOrg = {
			folders: [
				{ id: "zeta", name: "Same", parentId: null, createdAt: STAMP },
				{ id: "alpha", name: "Same", parentId: null, createdAt: STAMP },
			],
			placements: {},
		};
		const view = buildSidebarFolderView([], org, "", new Set(), new Set());
		assert.deepEqual(
			view.roots.map((n) => (n.kind === "folder" ? n.folder.id : n.chat.id)),
			["alpha", "zeta"],
		);
	});

	it("no query: a chat with no placement, folderId null, or an unknown folder id sits at the root — every chat placed exactly once", () => {
		const view = buildSidebarFolderView(CHATS, ORG, "", new Set(), new Set());
		const rootChatIds = view.roots.filter((n) => n.kind === "chat").map((n) => n.chat.id);
		assert.deepEqual(rootChatIds, ["c_root1", "c_null", "c_orphan", "c_prac"]);

		const alg = view.roots.find((n) => n.kind === "folder" && n.folder.id === "alg");
		assert.ok(alg?.kind === "folder");
		assert.deepEqual(
			alg.children.filter((n) => n.kind === "chat").map((n) => n.chat.id),
			["c_alg1"],
		);

		assert.deepEqual([...allChatIds(view.roots)].sort(), [...CHATS.map((c) => c.id)].sort());
	});

	it("practice chat with a placement inside a folder stays at the root, in normal and search mode", () => {
		const plain = buildSidebarFolderView(CHATS, ORG, "", new Set(), new Set());
		const alg = plain.roots.find((n) => n.kind === "folder" && n.folder.id === "alg");
		assert.ok(alg?.kind === "folder");
		assert.ok(!allChatIds(alg.children).includes("c_prac"), "practice chat is not inside Algebra");
		assert.ok(plain.roots.some((n) => n.kind === "chat" && n.chat.id === "c_prac"));

		const search = buildSidebarFolderView(CHATS, ORG, "integrals", new Set(), new Set());
		assert.deepEqual(search.roots.map(label), ["C:c_prac"], "title match lands at the root, not in Algebra");
		assert.deepEqual(search.visibleChatIds, ["c_prac"]);
	});
});

describe("buildSidebarFolderView — expansion and visibleChatIds", () => {
	it("no query, nothing expanded: empty and notes-only folders are present, all folders collapsed, only root chats visible", () => {
		const view = buildSidebarFolderView(CHATS, ORG, "", new Set(), new Set());
		const folders = allFolders(view.roots);
		assert.equal(folders.length, FOLDERS.length);
		assert.ok(folders.every((f) => f.expanded === false));
		const names = folders.map((f) => f.folder.name);
		assert.ok(names.includes("Notes only"), "a folder with no chats is still listed");
		assert.ok(names.includes("Empty"), "an empty folder is still listed");
		assert.deepEqual(view.visibleChatIds, ["c_root1", "c_null", "c_orphan", "c_prac"]);
	});

	it("expanding Algebra reveals its chats before the root chats; Maps' chats stay hidden until Maps itself is open", () => {
		const algOnly = buildSidebarFolderView(CHATS, ORG, "", new Set(["alg"]), new Set());
		assert.deepEqual(algOnly.visibleChatIds, ["c_alg1", "c_root1", "c_null", "c_orphan", "c_prac"]);

		const mapsOnly = buildSidebarFolderView(CHATS, ORG, "", new Set(["maps"]), new Set());
		assert.deepEqual(
			mapsOnly.visibleChatIds,
			["c_root1", "c_null", "c_orphan", "c_prac"],
			"a collapsed ancestor hides everything below, even an expanded descendant",
		);

		const both = buildSidebarFolderView(CHATS, ORG, "", new Set(["alg", "maps"]), new Set());
		assert.deepEqual(both.visibleChatIds, [
			"c_maps1",
			"c_maps2",
			"c_alg1",
			"c_root1",
			"c_null",
			"c_orphan",
			"c_prac",
		]);
	});
});

describe("buildSidebarFolderView — search", () => {
	it("a chat-title match shows only its ancestor path, folders expanded by default, expandedIds ignored", () => {
		const view = buildSidebarFolderView(CHATS, ORG, "eigenstuff", new Set(["empty", "notes", "f10", "f2"]), new Set());
		assert.deepEqual(view.roots.map(label), ["F:Algebra"], "unrelated, empty and notes-only folders are absent");

		const alg = view.roots[0];
		assert.ok(alg?.kind === "folder" && alg.expanded === true);
		assert.deepEqual(alg.children.map(label), ["F:Maps"]);

		const maps = alg.children[0];
		assert.ok(maps?.kind === "folder" && maps.expanded === true);
		assert.deepEqual(maps.children.map(label), ["C:c_maps1"]);
		assert.deepEqual(view.visibleChatIds, ["c_maps1"]);
	});

	it("a folder-name match reveals the whole subtree, including chats with non-matching titles", () => {
		const view = buildSidebarFolderView(CHATS, ORG, "algebra", new Set(), new Set());
		assert.deepEqual(view.roots.map(label), ["F:Algebra"]);

		const alg = view.roots[0];
		assert.ok(alg?.kind === "folder");
		assert.deepEqual(alg.children.map(label), ["F:Maps", "C:c_alg1"]);

		const maps = alg.children[0];
		assert.ok(maps?.kind === "folder");
		assert.deepEqual(maps.children.map(label), ["C:c_maps1", "C:c_maps2"]);
		assert.deepEqual(view.visibleChatIds, ["c_maps1", "c_maps2", "c_alg1"]);
	});

	it("a folder-name match on a chatless folder shows it with no children", () => {
		const view = buildSidebarFolderView(CHATS, ORG, "notes", new Set(), new Set());
		assert.deepEqual(view.roots.map(label), ["F:Notes only"]);
		const notes = view.roots[0];
		assert.ok(notes?.kind === "folder" && notes.expanded === true && notes.children.length === 0);
		assert.deepEqual(view.visibleChatIds, []);
	});

	it("search order inside a folder: title matches by descending score first, then folder-only chats in input order", () => {
		const org: TestOrg = {
			folders: [{ id: "math", name: "Math", parentId: null, createdAt: STAMP }],
			placements: {
				c1: { folderId: "math" },
				c2: { folderId: "math" },
				c3: { folderId: "math" },
				c4: { folderId: "math" },
				c5: { folderId: "math" },
			},
		};
		// Input order is deliberately scrambled; "mat" name-matches "Math",
		// revealing every chat, while only some titles score on their own.
		const chats = [
			chat("c3", { title: "Geometry" }),
			chat("c5", { title: "Material" }),
			chat("c1", { title: "Math advanced" }),
			chat("c4", { title: "Trigonometry" }),
			chat("c2", { title: "Format" }),
		];
		const view = buildSidebarFolderView(chats, org, "mat", new Set(), new Set());
		const math = view.roots[0];
		assert.ok(math?.kind === "folder");
		assert.deepEqual(
			math.children.map(label),
			["C:c5", "C:c1", "C:c2", "C:c3", "C:c4"],
			"title scores: Material=110, Math advanced=110 (input order), Format=77; Geometry/Trigonometry follow in input order",
		);
	});

	it("searchCollapsedIds collapses a branch: expanded=false and its chats leave visibleChatIds", () => {
		const view = buildSidebarFolderView(CHATS, ORG, "eigenstuff", new Set(), new Set(["maps"]));
		const alg = view.roots[0];
		assert.ok(alg?.kind === "folder" && alg.expanded === true);
		const maps = alg.children[0];
		assert.ok(maps?.kind === "folder" && maps.expanded === false);
		assert.deepEqual(view.visibleChatIds, [], "a collapsed branch hides its chats even in search");

		const collapsedRoot = buildSidebarFolderView(CHATS, ORG, "eigenstuff", new Set(), new Set(["alg"]));
		const rootAlg = collapsedRoot.roots[0];
		assert.ok(rootAlg?.kind === "folder" && rootAlg.expanded === false);
		assert.deepEqual(collapsedRoot.visibleChatIds, []);
	});

	it("a query with no matches yields empty roots and visibleChatIds", () => {
		const view = buildSidebarFolderView(CHATS, ORG, "qqqxyz", new Set(), new Set());
		assert.deepEqual(view.roots, []);
		assert.deepEqual(view.visibleChatIds, []);
	});
});

describe("keyboard walk helpers", () => {
	it("nextKbdChat: empty → null; null/unknown current → first (dir 1) or last (dir -1); wraps both ways", () => {
		assert.equal(nextKbdChat([], null, 1), null);
		assert.equal(nextKbdChat([], "a", -1), null);

		const ids = ["a", "b", "c"];
		assert.equal(nextKbdChat(ids, null, 1), "a");
		assert.equal(nextKbdChat(ids, null, -1), "c");
		assert.equal(nextKbdChat(ids, "zzz", 1), "a", "unknown current restarts at the dir's end");
		assert.equal(nextKbdChat(ids, "zzz", -1), "c");
		assert.equal(nextKbdChat(ids, "a", 1), "b");
		assert.equal(nextKbdChat(ids, "c", 1), "a", "wraps forward");
		assert.equal(nextKbdChat(ids, "a", -1), "c", "wraps backward");
		assert.equal(nextKbdChat(ids, "c", -1), "b");
	});

	it("enterKbdChat: empty → null; known current → current; unknown or null → first", () => {
		assert.equal(enterKbdChat([], null), null);
		assert.equal(enterKbdChat([], "a"), null);
		assert.equal(enterKbdChat(["a", "b"], "b"), "b");
		assert.equal(enterKbdChat(["a", "b"], null), "a");
		assert.equal(enterKbdChat(["a", "b"], "zzz"), "a");
	});
});

describe("SidebarFolderTree render", () => {
	const render = (view: ReturnType<typeof buildSidebarFolderView>) =>
		renderToStaticMarkup(
			<SidebarFolderTree view={view} onToggleFolder={() => {}} renderChat={(c) => <span>{c.title}</span>} />,
		);

	it("collapsed folders render an aria-expanded=false button named by the folder with no child rows; expanded folders render children inside role=group after subfolders", () => {
		const view = buildSidebarFolderView(CHATS, ORG, "", new Set(["alg"]), new Set());
		const html = render(view);

		// Every folder row is a button whose accessible name is the folder name.
		const buttons = [...html.matchAll(/<button[^>]*data-sidebar-folder="([^"]+)"[^>]*>/g)];
		const expandedById = new Map(buttons.map((m) => [m[1], /aria-expanded="true"/.test(m[0])]));
		assert.equal(expandedById.get("alg"), true);
		assert.equal(expandedById.get("maps"), false, "Maps stays collapsed — only Algebra was opened");
		assert.equal(expandedById.get("notes"), false);
		assert.equal(expandedById.get("empty"), false);
		assert.equal(buttons.length, FOLDERS.length, "every folder renders a row even when collapsed");

		const algButton = html.match(/<button[^>]*data-sidebar-folder="alg"[^>]*>[\s\S]*?<\/button>/);
		assert.ok(algButton?.[0].includes("Algebra"), "the folder name is the button's visible text");

		// Collapsed Maps hides its chat rows entirely.
		assert.ok(!html.includes('data-sidebar-chat="c_maps1"'));
		assert.ok(!html.includes('data-sidebar-chat="c_maps2"'));
		assert.ok(html.includes('data-sidebar-chat="c_alg1"'), "expanded Algebra shows its direct chat");
		assert.ok(html.includes('role="group"'), "expanded children sit inside a group");

		// With Maps open too, its subtree renders nested chat rows — the
		// Maps subfolder (and its whole subtree) precedes Algebra's own
		// chat row.
		const open = buildSidebarFolderView(CHATS, ORG, "", new Set(["alg", "maps"]), new Set());
		const openHtml = render(open);
		assert.equal((openHtml.match(/role="group"/g) ?? []).length, 2, "one group per expanded folder");
		assert.ok(openHtml.includes('data-sidebar-chat="c_maps1"'));
		assert.ok(openHtml.includes('data-sidebar-chat="c_maps2"'));
		assert.ok(openHtml.indexOf('data-sidebar-folder="maps"') < openHtml.indexOf('data-sidebar-chat="c_maps1"'));
		assert.ok(openHtml.indexOf('data-sidebar-folder="maps"') < openHtml.indexOf('data-sidebar-chat="c_alg1"'));
		assert.ok(openHtml.indexOf('data-sidebar-chat="c_maps2"') < openHtml.indexOf('data-sidebar-chat="c_alg1"'));
	});
});
