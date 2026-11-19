/**
 * SIDEBAR FOLDER ACTIONS (chat-folders S04, 2026-11-19): the pure half of
 * the sidebar's folder writes — target/path planning against the freshest
 * organization snapshot, the POST /api/graph/sources command channel, the
 * one-write-at-a-time serializer, and the SSR-pinned dialog bodies.
 * Same tsx classic-JSX shim as sidebar-folder-tree.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	canDropChat,
	createFolderWriter,
	currentChatFolder,
	folderPath,
	folderTargets,
	MoveChatBody,
	NewFolderBody,
	planCreateFolder,
	planMoveChat,
	postFolderCommand,
	readDragPayload,
	type FolderCommand,
	type FolderWriteResult,
} from "../components/sidebar-folder-actions.tsx";
import type { ChatListItem, ChatListResponse } from "../src/core/index.ts";

type TestOrg = NonNullable<ChatListResponse["organization"]>;

const STAMP = "2026-01-01T00:00:00.000Z";

function chat(id: string, overrides: Partial<ChatListItem> = {}): ChatListItem {
	return {
		id,
		title: id,
		kind: "teach",
		createdAt: STAMP,
		updatedAt: STAMP,
		messageCount: 1,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

/* Shared fixture: Algebra → Maps nesting, a notes-only folder, and chats
 * placed at each level plus a practice chat inside Algebra. */
const ORG: TestOrg = {
	folders: [
		{ id: "alg", name: "Algebra", parentId: null, createdAt: STAMP },
		{ id: "maps", name: "Maps", parentId: "alg", createdAt: STAMP },
		{ id: "notes", name: "Notes only", parentId: null, createdAt: STAMP },
	],
	placements: {
		c_alg: { folderId: "alg" },
		c_maps: { folderId: "maps" },
		c_prac: { folderId: "alg" },
	},
};

const AMBIGUOUS =
	"Could not confirm the folder change. The list was refreshed; try again if it is still needed.";

describe("folderTargets", () => {
	it("lists Outside folders first, then every folder by full-path label in collator order", () => {
		const org: TestOrg = {
			folders: [
				{ id: "f10", name: "folder 10", parentId: null, createdAt: STAMP },
				{ id: "alg", name: "Algebra", parentId: null, createdAt: STAMP },
				{ id: "maps", name: "Maps", parentId: "alg", createdAt: STAMP },
				{ id: "f2", name: "Folder 2", parentId: null, createdAt: STAMP },
			],
			placements: {},
		};
		const targets = folderTargets(org);
		assert.deepEqual(
			targets.map((t) => t.label),
			["Outside folders", "Algebra", "Algebra / Maps", "Folder 2", "folder 10"],
			"numeric + case-insensitive collator: Folder 2 before folder 10",
		);
		assert.equal(targets[0]?.id, null);
		assert.equal(targets.find((t) => t.label === "Algebra / Maps")?.id, "maps");
	});

	it("two folders with the same full path each get the 6-char id suffix; same name under different parents does not", () => {
		const org: TestOrg = {
			folders: [
				{ id: "dup-000001", name: "Same", parentId: null, createdAt: STAMP },
				{ id: "dup-000002", name: "Same", parentId: null, createdAt: STAMP },
				{ id: "p1", name: "Parent", parentId: null, createdAt: STAMP },
				{ id: "p2", name: "Other", parentId: null, createdAt: STAMP },
				{ id: "k1", name: "Kid", parentId: "p1", createdAt: STAMP },
				{ id: "k2", name: "Kid", parentId: "p2", createdAt: STAMP },
			],
			placements: {},
		};
		const labels = folderTargets(org).map((t) => t.label);
		assert.ok(labels.includes("Same (000001)"), `expected the id-suffixed label, got ${labels.join(", ")}`);
		assert.ok(labels.includes("Same (000002)"));
		assert.ok(labels.includes("Parent / Kid"));
		assert.ok(labels.includes("Other / Kid"));
		assert.ok(!labels.some((l) => l.includes("Kid (")), "distinct full paths need no suffix");
	});
});

describe("folderPath", () => {
	it("returns root-to-leaf ids; [] for null or unknown; cycle-safe", () => {
		assert.deepEqual(folderPath(ORG, null), []);
		assert.deepEqual(folderPath(ORG, "ghost"), []);
		assert.deepEqual(folderPath(ORG, "alg"), ["alg"]);
		assert.deepEqual(folderPath(ORG, "maps"), ["alg", "maps"]);

		const dangling: TestOrg = {
			folders: [{ id: "x", name: "X", parentId: "ghost", createdAt: STAMP }],
			placements: {},
		};
		assert.deepEqual(folderPath(dangling, "x"), ["x"], "an unknown parent reads as root-level");

		const cyclic: TestOrg = {
			folders: [
				{ id: "a", name: "A", parentId: "b", createdAt: STAMP },
				{ id: "b", name: "B", parentId: "a", createdAt: STAMP },
			],
			placements: {},
		};
		const path = folderPath(cyclic, "a");
		assert.ok(path.includes("a") && path.length <= 2, "a parent cycle terminates instead of looping");
	});
});

describe("currentChatFolder", () => {
	it("mirrors the tree's placement rule: existing folder id, else null; practice always null", () => {
		assert.equal(currentChatFolder(ORG, chat("c_alg")), "alg");
		assert.equal(currentChatFolder(ORG, chat("c_maps")), "maps");
		assert.equal(currentChatFolder(ORG, chat("c_none")), null, "no placement entry");

		const org: TestOrg = {
			folders: ORG.folders,
			placements: { c_null: { folderId: null }, c_ghost: { folderId: "ghost" } },
		};
		assert.equal(currentChatFolder(org, chat("c_null")), null, "explicit folderId null");
		assert.equal(currentChatFolder(org, chat("c_ghost")), null, "unknown folder id");
		assert.equal(currentChatFolder(ORG, chat("c_prac", { kind: "practice" })), null, "practice never folders");
	});
});

describe("readDragPayload", () => {
	it("parses source/folder payloads; anything else is null", () => {
		assert.deepEqual(readDragPayload(JSON.stringify({ kind: "source", id: "c1" })), { kind: "source", id: "c1" });
		assert.deepEqual(readDragPayload(JSON.stringify({ kind: "folder", id: "f1" })), { kind: "folder", id: "f1" });
		for (const raw of [
			"null",
			"3",
			'"text"',
			"{",
			JSON.stringify({ kind: "source" }),
			JSON.stringify({ kind: "source", id: "" }),
			JSON.stringify({ kind: "other", id: "x" }),
		]) {
			assert.equal(readDragPayload(raw), null, raw);
		}
	});
});

describe("canDropChat", () => {
	it("requires a known teaching chat and an existing target different from the current folder", () => {
		const chats = [chat("c_alg"), chat("c_root"), chat("c_prac", { kind: "practice" })];
		assert.equal(canDropChat(ORG, chats, "ghost", "maps"), false, "unknown chat");
		assert.equal(canDropChat(ORG, chats, "c_prac", "maps"), false, "practice chats never folder");
		assert.equal(canDropChat(ORG, chats, "c_root", "ghost"), false, "unknown target folder");
		assert.equal(canDropChat(ORG, chats, "c_alg", "alg"), false, "already in that folder");
		assert.equal(canDropChat(ORG, chats, "c_root", null), false, "root → Outside folders is a no-op");
		assert.equal(canDropChat(ORG, chats, "c_alg", "maps"), true, "another existing folder");
		assert.equal(canDropChat(ORG, chats, "c_alg", null), true, "folder → Outside folders");
	});
});

describe("planCreateFolder", () => {
	it("rejects a blank name and an unknown parent; otherwise commands with the trimmed name", () => {
		assert.deepEqual(planCreateFolder(ORG, "   ", null), { kind: "error", error: "Enter a folder name." });
		assert.deepEqual(planCreateFolder(ORG, "New", "ghost"), {
			kind: "error",
			error: "That folder no longer exists.",
		});
		assert.deepEqual(planCreateFolder(ORG, "  Algebra II  ", null), {
			kind: "command",
			command: { action: "create-folder", name: "Algebra II", parentId: null },
		});
		assert.deepEqual(planCreateFolder(ORG, "Inner", "alg"), {
			kind: "command",
			command: { action: "create-folder", name: "Inner", parentId: "alg" },
		});
	});
});

describe("planMoveChat", () => {
	it("rejects missing/practice/unknown-target, skips the current folder, else commands the move", () => {
		const chats = [chat("c_root"), chat("c_alg"), chat("c_prac", { kind: "practice" })];
		assert.deepEqual(planMoveChat(ORG, chats, "ghost", null), {
			kind: "error",
			error: "This session no longer exists.",
		});
		assert.deepEqual(planMoveChat(ORG, chats, "c_prac", "alg"), {
			kind: "error",
			error: "Practice sessions stay outside folders.",
		});
		assert.deepEqual(planMoveChat(ORG, chats, "c_root", "ghost"), {
			kind: "error",
			error: "That folder no longer exists.",
		});
		assert.deepEqual(planMoveChat(ORG, chats, "c_root", null), { kind: "skip" }, "root → root is a no-op");
		assert.deepEqual(planMoveChat(ORG, chats, "c_alg", "alg"), { kind: "skip" }, "same folder is a no-op");
		assert.deepEqual(planMoveChat(ORG, chats, "c_root", "alg"), {
			kind: "command",
			command: { action: "move", kind: "source", id: "c_root", parentId: "alg" },
		});
		assert.deepEqual(planMoveChat(ORG, chats, "c_alg", null), {
			kind: "command",
			command: { action: "move", kind: "source", id: "c_alg", parentId: null },
		});
	});
});

describe("postFolderCommand", () => {
	it("POSTs the command as JSON to /api/graph/sources and returns createdFolderId on 2xx", async () => {
		const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
		const fetchImpl: typeof fetch = async (url, init) => {
			calls.push({ url, init });
			return new Response(JSON.stringify({ createdFolderId: "folder_new_1" }), { status: 200 });
		};
		const command: FolderCommand = { action: "create-folder", name: "Maps", parentId: "alg" };
		const result = await postFolderCommand(command, fetchImpl);
		assert.deepEqual(result, { ok: true, createdFolderId: "folder_new_1" });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.url, "/api/graph/sources");
		assert.equal(calls[0]?.init?.method, "POST");
		assert.deepEqual(calls[0]?.init?.headers, { "Content-Type": "application/json" });
		assert.equal(calls[0]?.init?.body, JSON.stringify(command));

		const plain: typeof fetch = async () => new Response(JSON.stringify({ sources: [] }), { status: 200 });
		assert.deepEqual(await postFolderCommand(command, plain), { ok: true }, "no createdFolderId → plain ok");
	});

	it("400 surfaces the server's error as a definite rejection; a missing error field uses the default", async () => {
		const command: FolderCommand = { action: "move", kind: "source", id: "c1", parentId: null };
		const rejected: typeof fetch = async () =>
			new Response(JSON.stringify({ error: "Parent folder no longer exists." }), { status: 400 });
		assert.deepEqual(await postFolderCommand(command, rejected), {
			ok: false,
			error: "Parent folder no longer exists.",
			ambiguous: false,
		});

		const noMessage: typeof fetch = async () => new Response(JSON.stringify({}), { status: 400 });
		assert.deepEqual(await postFolderCommand(command, noMessage), {
			ok: false,
			error: "The folder change was rejected.",
			ambiguous: false,
		});
	});

	it("500 and a thrown fetch are ambiguous with the confirm-failure text", async () => {
		const command: FolderCommand = { action: "create-folder", name: "X", parentId: null };
		const serverError: typeof fetch = async () =>
			new Response(JSON.stringify({ error: "Could not save source organization." }), { status: 500 });
		const result = await postFolderCommand(command, serverError);
		assert.deepEqual(result, { ok: false, ambiguous: true, error: AMBIGUOUS });

		const thrown: typeof fetch = async () => {
			throw new Error("network down");
		};
		assert.deepEqual(await postFolderCommand(command, thrown), result);
	});
});

describe("createFolderWriter", () => {
	it("rejects a second write while one is in flight, then accepts the next after it settles", async () => {
		const posted: FolderCommand[] = [];
		const resolvers: Array<(r: FolderWriteResult) => void> = [];
		const writer = createFolderWriter({
			post: (command) => {
				posted.push(command);
				return new Promise<FolderWriteResult>((resolve) => resolvers.push(resolve));
			},
			afterWrite: () => {},
		});
		const cmd1: FolderCommand = { action: "create-folder", name: "One", parentId: null };
		const cmd2: FolderCommand = { action: "create-folder", name: "Two", parentId: null };
		const cmd3: FolderCommand = { action: "create-folder", name: "Three", parentId: null };

		const first = writer.write(cmd1);
		const second = writer.write(cmd2);
		assert.deepEqual(await second, {
			ok: false,
			ambiguous: false,
			error: "Another folder change is still saving.",
		});
		assert.equal(posted.length, 1, "the overlapping write never reached post");

		resolvers[0]?.({ ok: true });
		assert.deepEqual(await first, { ok: true });

		const third = writer.write(cmd3);
		resolvers[1]?.({ ok: true });
		assert.deepEqual(await third, { ok: true });
		assert.deepEqual(posted, [cmd1, cmd3], "the next write posts once the first settled");
	});

	it("awaits afterWrite with the command and result after success and failure, before write resolves", async () => {
		const seen: Array<{ command: FolderCommand; result: FolderWriteResult }> = [];
		const writer = createFolderWriter({
			post: async (command) =>
				command.action === "create-folder" && command.name === "Bad"
					? ({ ok: false, error: "nope", ambiguous: false } as FolderWriteResult)
					: ({ ok: true } as FolderWriteResult),
			afterWrite: (command, result) => {
				seen.push({ command, result });
			},
		});
		const good: FolderCommand = { action: "create-folder", name: "Good", parentId: null };
		const bad: FolderCommand = { action: "create-folder", name: "Bad", parentId: null };
		await writer.write(good);
		await writer.write(bad);
		assert.equal(seen.length, 2);
		assert.deepEqual(seen[0], { command: good, result: { ok: true } });
		assert.deepEqual(seen[1], { command: bad, result: { ok: false, error: "nope", ambiguous: false } });

		// afterWrite is awaited: write() stays pending until it finishes.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const gated = createFolderWriter({
			post: async () => ({ ok: true }),
			afterWrite: () => gate,
		});
		let settled = false;
		const pending = gated.write(good).then((r) => {
			settled = true;
			return r;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(settled, false, "write() waits for afterWrite to finish");
		release();
		await pending;
		assert.equal(settled, true);
	});
});

describe("NewFolderBody", () => {
	const targets = folderTargets(ORG);
	const render = (props: Partial<Parameters<typeof NewFolderBody>[0]> = {}) =>
		renderToStaticMarkup(
			<NewFolderBody
				name=""
				parentId={null}
				targets={targets}
				busy={false}
				error={null}
				onName={() => {}}
				onParent={() => {}}
				onCancel={() => {}}
				onCreate={() => {}}
				{...props}
			/>,
		);

	it("renders the labelled fields and one option per target, gates Create on a non-blank name, pins busy and error", () => {
		const html = render();
		assert.ok(html.includes('data-testid="new-folder-dialog"'));
		assert.ok(html.includes('aria-label="New folder"'));
		assert.match(html, /<label[^>]*for="new-folder-name"[^>]*>\s*Name\s*<\/label>/, "the Name input is labelled");
		assert.ok(html.includes('data-testid="new-folder-name"'));
		assert.match(html, /<label[^>]*for="new-folder-parent"[^>]*>\s*Parent folder\s*<\/label>/);

		const select = html.match(/<select[^>]*data-testid="new-folder-parent"[^>]*>([\s\S]*?)<\/select>/);
		assert.ok(select, "the parent select renders");
		const options = [...(select?.[1] ?? "").matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)];
		assert.equal(options.length, targets.length, "one option per target");
		assert.equal(options[0]?.[1], "");
		assert.equal(options[0]?.[2], "Outside folders");
		assert.ok(options.some((o) => o[1] === "maps" && o[2] === "Algebra / Maps"));

		const create = html.match(/<button[^>]*data-testid="new-folder-create"[^>]*>/);
		assert.ok(create?.[0].includes('disabled=""'), "blank name keeps Create disabled");
		assert.ok(html.includes(">Create</button>"));

		const named = render({ name: "Maps" });
		const createNamed = named.match(/<button[^>]*data-testid="new-folder-create"[^>]*>/);
		assert.ok(createNamed && !createNamed[0].includes('disabled=""'), "a name enables Create");

		const busy = render({ name: "Maps", busy: true });
		assert.ok(busy.includes("Creating…"));
		const cancelBusy = busy.match(/<button[^>]*data-testid="new-folder-cancel"[^>]*>/);
		assert.ok(cancelBusy?.[0].includes('disabled=""'), "Cancel is disabled while busy");
		const createBusy = busy.match(/<button[^>]*data-testid="new-folder-create"[^>]*>/);
		assert.ok(createBusy?.[0].includes('disabled=""'));

		const failed = render({ error: "That folder no longer exists." });
		assert.ok(failed.includes('role="alert"'));
		assert.ok(failed.includes('data-testid="new-folder-error"'));
		assert.ok(failed.includes("That folder no longer exists."));
	});
});

describe("MoveChatBody", () => {
	const targets = folderTargets(ORG);
	const render = (props: Partial<Parameters<typeof MoveChatBody>[0]> = {}) =>
		renderToStaticMarkup(
			<MoveChatBody
				chatTitle="Linear maps"
				currentId="alg"
				targetId="alg"
				targets={targets}
				busy={false}
				error={null}
				onTarget={() => {}}
				onCancel={() => {}}
				onMove={() => {}}
				{...props}
			/>,
		);

	it("shows the title and current folder, lists every target, and gates Move on a real change", () => {
		const html = render();
		assert.ok(html.includes('data-testid="move-chat-dialog"'));
		assert.ok(html.includes('aria-label="Move to folder"'));
		assert.ok(html.includes("Linear maps"), "the chat title renders");

		const current = html.match(/<p[^>]*data-testid="move-chat-current"[^>]*>([\s\S]*?)<\/p>/);
		assert.ok(current, "the current-folder line renders");
		assert.ok(current[1]?.includes("Currently in:"), "it is labelled");
		assert.ok(current[1]?.includes("Algebra"), "the current folder's label");

		const select = html.match(/<select[^>]*data-testid="move-chat-target"[^>]*>([\s\S]*?)<\/select>/);
		assert.ok(select, "the target select renders");
		const options = [...(select?.[1] ?? "").matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)];
		assert.equal(options.length, targets.length, "Outside folders plus every folder path");
		assert.equal(options[0]?.[1], "");
		assert.equal(options[0]?.[2], "Outside folders");
		assert.ok(options.some((o) => o[1] === "maps" && o[2] === "Algebra / Maps"));
		assert.match(html, /<label[^>]*for="move-chat-target"[^>]*>\s*Folder\s*<\/label>/);

		const move = html.match(/<button[^>]*data-testid="move-chat-confirm"[^>]*>/);
		assert.ok(move?.[0].includes('disabled=""'), "target === current keeps Move disabled");
		assert.ok(html.includes(">Move</button>"));

		const changed = render({ targetId: "maps" });
		const moveChanged = changed.match(/<button[^>]*data-testid="move-chat-confirm"[^>]*>/);
		assert.ok(moveChanged && !moveChanged[0].includes('disabled=""'), "a different target enables Move");

		const busy = render({ targetId: "maps", busy: true, error: "Practice sessions stay outside folders." });
		assert.ok(busy.includes("Moving…"));
		assert.ok(busy.includes('role="alert"'));
		assert.ok(busy.includes('data-testid="move-chat-error"'));
		assert.ok(busy.includes("Practice sessions stay outside folders."));
	});
});
