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
