import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NewFolderRow, SidebarFolderRow, SidebarFolderRule, sidebarFolderBox, sidebarRail, sidebarRowBox, sidebarRuleInset } from "../components/sidebar-folders.tsx";

const folder = { id: "f1", name: "Physics", parentId: null, createdAt: "2026-10-01T00:00:00.000Z" };
const row = (depth: number, open: boolean, compact = false) => renderToStaticMarkup(
	<SidebarFolderRow folder={folder} depth={depth} open={open} compact={compact} dropActive={false} renaming={false} draggable
		onToggle={() => {}} onContextMenu={() => {}} onRename={async () => {}} onRenameDone={() => {}} />,
);

it("nested rows still start at the parent's rail without a rule on the folder heading itself", () => {
	assert.equal(sidebarRail(0), 15);
	assert.deepEqual([sidebarRuleInset(0), sidebarRuleInset(1), sidebarRuleInset(2)], [0, 15, 33]);
	assert.deepEqual(sidebarRowBox(2), { marginLeft: 33, paddingLeft: 15 });
	assert.deepEqual(sidebarFolderBox(0), { marginLeft: 0, paddingLeft: 8 }, "the chevron glyph lines up with session titles at 12px");
	const html = row(1, false);
	assert.match(html, /data-testid="sidebar-folder-row-f1"[^>]*style="margin-left:15px"/);
	assert.match(html, /data-testid="sidebar-folder-f1"[^>]*style="padding-left:11px"/);
	assert.doesNotMatch(html + row(1, true), /data-sidebar-folder-rule|border-bottom/);
});

it("folder names use the reading font by default and the same compact styling as sessions when enabled", () => {
	assert.match(row(0, false), /font-prose[^>]*>Physics/);
	const compact = row(0, false, true);
	assert.match(compact, /\bh-8\b/);
	const button = compact.match(/<button\b[^>]*>/)?.[0] ?? "";
	assert.match(button, /hover:bg-accent/);
	assert.doesNotMatch(button, /transition-colors|duration-\d/);
	assert.match(compact, /\bfont-ui\b[^>]*>Physics/);
});

it("folder boundaries use top and bottom rules aligned to the parent rail", () => {
	assert.match(renderToStaticMarkup(<SidebarFolderRule depth={0} edge="top" />), /data-sidebar-folder-rule="top"[^>]*\btop-0[^>]*style="left:0"/);
	assert.match(renderToStaticMarkup(<SidebarFolderRule depth={2} edge="bottom" />), /data-sidebar-folder-rule="bottom"[^>]*\bbottom-0[^>]*style="left:33px"/);
	assert.match(renderToStaticMarkup(<NewFolderRow depth={1} onCreate={async () => {}} onDone={() => {}} />), /style="margin-left:15px;padding-left:11px"/);
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
