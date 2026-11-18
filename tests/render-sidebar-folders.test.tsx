import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NewFolderRow, SidebarFolderRow, sidebarFolderBox, sidebarRail, sidebarRowBox, sidebarRuleInset } from "../components/sidebar-folders.tsx";

const folder = { id: "f1", name: "Physics", parentId: null, createdAt: "2026-10-01T00:00:00.000Z" };
const row = (depth: number, contentsShown: boolean) => renderToStaticMarkup(
	<SidebarFolderRow folder={folder} depth={depth} open={contentsShown} contentsShown={contentsShown} dropActive={false} renaming={false} draggable
		onToggle={() => {}} onContextMenu={() => {}} onRename={async () => {}} onRenameDone={() => {}} />,
);

it("nested rows start at the parent's rail; the rule slot is an inline transparent border", () => {
	assert.equal(sidebarRail(0), 15);
	assert.deepEqual([sidebarRuleInset(0), sidebarRuleInset(1), sidebarRuleInset(2)], [0, 15, 33]);
	assert.deepEqual(sidebarRowBox(2), { marginLeft: 33, paddingLeft: 15 });
	assert.deepEqual(sidebarFolderBox(0), { marginLeft: 0, paddingLeft: 8 }, "the chevron glyph lines up with session titles at 12px");
	const html = row(1, false);
	assert.match(html, /data-testid="sidebar-folder-row-f1"[^>]*style="border-bottom:1px solid transparent;margin-left:15px"/);
	assert.match(html, /data-testid="sidebar-folder-f1"[^>]*style="padding-left:11px"/);
	assert.match(html, /data-testid="sidebar-folder-rule-f1"[^>]*style="left:0"/, "closed: the rule spans the row");
});

it("an open folder with contents heads them with a rule starting at its own rail", () => {
	assert.match(row(0, true), /data-testid="sidebar-folder-rule-f1"[^>]*style="left:15px"/);
	assert.match(row(1, true), /data-testid="sidebar-folder-rule-f1"[^>]*style="left:18px"/, "rail 33 minus the row's 15px start");
	assert.match(renderToStaticMarkup(<NewFolderRow depth={1} onCreate={async () => {}} onDone={() => {}} />), /style="border-bottom:1px solid transparent;margin-left:15px;padding-left:11px"/);
});

it("the folder Delete reuses the session dialog's surface with plural wording", async () => {
	const { DeleteSessionBody, folderDeleteCopy } = await import("../components/delete-session-dialog.tsx");
	const copy = folderDeleteCopy({ sessions: 3, subfolders: 1, notes: 2, parentName: null });
	const html = renderToStaticMarkup(<DeleteSessionBody chat={{ id: "f1", title: "Physics" }} copy={copy} traces={false} busy={false}
		failure={null} onTraces={() => {}} onClose={() => {}} onRun={() => {}} />);
	assert.match(html, /data-testid="delete-folder-dialog"/);
	assert.match(html, /Delete folder\?/);
	assert.match(html, />Physics</);
	assert.match(html, /the 3 sessions and 1 subfolder inside/);
	assert.match(html, /2 imported notes files inside move to the top level\./);
	assert.match(html, /Also remove their graph traces/);
	assert.match(html, /data-testid="delete-traces-checkbox"/);
	const one = folderDeleteCopy({ sessions: 1, subfolders: 0, notes: 1, parentName: "Top" });
	assert.match(one.body, /the 1 session inside/);
	assert.match(one.body, /1 imported notes file inside moves to “Top”\./);
});
