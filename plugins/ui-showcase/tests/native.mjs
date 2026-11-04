/** Product-only native Chrome proof; run after the parent hands off its build:
 * LH_POLISH_BUILD_READY=1 LH_APPROVED_HOST_DIGEST=<approved-tree-sha256>
 * LH_STANDALONE=/newly-verified/.next/standalone npm run test:native
 * This imports only test helpers/browser automation, never checkout host runtime.
 * Microphone recording and OS IME testing are explicitly OUT OF SCOPE.
 */
import assert from "node:assert/strict";
import { runPackagedProof } from "./isolated.mjs";

const gallery = '[data-showcase="gallery"]';
const example = (id, root = gallery) => `${root} [data-example="${id}"]`;
const button = (id, root = gallery) => `${example(id, root)} button`;
const familyIds = ["pickers", "composer", "dictation", "standard-composer", "buttons", "settings", "markdown", "tree", "worker-results", "menus", "dialogs", "surfaces"];

await runPackagedProof(async ({ page, api, base, fixture, evidence, screenshot }) => {
  const cdp = await page.createCDPSession();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const chord = async key => { await page.keyboard.down(mod); try { await page.keyboard.press(key); } finally { await page.keyboard.up(mod); } };
  const fill = async (selector, text) => {
    await page.locator(selector).click(); await page.focus(selector);
    const key = { key: "a", code: "KeyA", modifiers: mod === "Meta" ? 4 : 2 };
    await cdp.send("Input.dispatchKeyEvent", { ...key, type: "keyDown", commands: ["selectAll"] });
    await cdp.send("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
    await page.keyboard.sendCharacter(text);
  };
  const state = (id, root = gallery) => page.$eval(`${root} [data-state="${id}"]`, node => JSON.parse(node.textContent));
  const waitState = (id, expected, root = gallery) => page.waitForFunction(({ id, expected, root }) => {
    const node = document.querySelector(`${root} [data-state="${id}"]`);
    if (!node) return false; const value = JSON.parse(node.textContent);
    return Object.entries(expected).every(([key, expected]) => JSON.stringify(value[key]) === JSON.stringify(expected));
  }, {}, { id, expected, root });
  const click = id => page.locator(button(id)).click();
  const reset = id => click(`reset-${id}`);
  const openGallery = async () => { await page.locator('[data-plugin-action="ui-showcase/gallery-sidebar"]').click(); await page.waitForSelector(gallery, { visible: true }); };
  const settlePaint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const paintedTop = selector => page.$eval(selector, node => {
    const b = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(Math.min(innerWidth - 1, Math.max(1, b.x + b.width / 2)), Math.min(innerHeight - 1, Math.max(1, b.y + Math.min(b.height / 2, 150)))));
  });
  const overlayChrome = (selector, title, surface = false) => page.$eval(selector, (content, { title, surface }) => {
    const frame = content.closest(surface ? '[data-plugin-session-surface-frame]' : '[data-plugin-ui-dialog]');
    const close = frame.querySelector(surface ? 'button[aria-label="Close"]' : 'button[aria-label="Close dialog"]');
    let scroll = frame.querySelector('[data-plugin-ui-dialog-scroll]');
    if (surface) {
      scroll = content;
      while (scroll !== frame && !(scroll.scrollHeight > scroll.clientHeight && /auto|scroll/.test(getComputedStyle(scroll).overflowY))) scroll = scroll.parentElement;
      if (scroll === frame) scroll = frame.firstElementChild;
    }
    const box = node => { const { x, y, width, height, right, bottom } = node.getBoundingClientRect(); return { x, y, width, height, right, bottom }; };
    const semantic = content.closest(surface ? '[data-plugin-session-surface]' : '[role="dialog"]');
    const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT); const nativeText = [];
    for (let node; (node = walker.nextNode());) if (!content.contains(node) && node.textContent.trim()) nativeText.push(node.textContent.trim());
    return { title, accessibleName: semantic.getAttribute('aria-label'), nativeText,
      hostHeadings: [...frame.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],header')].filter(node => !content.contains(node)).length,
      frame: box(frame), close: box(close), closeText: close.textContent.trim(), closeColor: getComputedStyle(close).color,
      mutedClose: close.classList.contains('text-muted-foreground'), scroll: box(scroll), scrollTop: scroll.scrollTop,
      scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight };
  }, { title, surface });
  const assertOverlayChrome = snapshot => {
    assert.equal(snapshot.accessibleName, snapshot.title, 'Host title remains accessible');
    assert.deepEqual(snapshot.nativeText, [], 'No visible host title/header or Close text');
    assert.equal(snapshot.hostHeadings, 0); assert.equal(snapshot.closeText, ''); assert.equal(snapshot.mutedClose, true);
    assert.ok(Math.abs(snapshot.close.y - snapshot.frame.y - 8) <= 2);
    assert.ok(Math.abs(snapshot.frame.right - snapshot.close.right - 8) <= 2);
    assert.ok(Math.abs(snapshot.scroll.right - snapshot.frame.right) <= 2, 'Scrollbar belongs at outer frame edge, not an inset content wrapper');
  };
  const assertPinnedWhileScrolling = async (selector, title, surface = false) => {
    const before = await overlayChrome(selector, title, surface); assertOverlayChrome(before);
    assert.ok(before.scrollHeight > before.clientHeight, 'Fixture must genuinely overflow');
    await page.mouse.move(before.frame.x + before.frame.width / 2, before.frame.y + before.frame.height / 2);
    await page.mouse.wheel({ deltaY: 420 }); await settlePaint();
    const after = await overlayChrome(selector, title, surface);
    assert.ok(after.scrollTop > before.scrollTop, 'Trusted wheel must scroll actual host content');
    for (const axis of ['x', 'y', 'right', 'bottom']) assert.ok(Math.abs(after.close[axis] - before.close[axis]) <= 1, `Floating X stays pinned while content scrolls: ${axis}`);
    assertOverlayChrome(after); return { before, after };
  };

  evidence.stage = "gallery";
  assert.equal((await page.goto(base + "/plugins/ui-showcase/gallery", { waitUntil: "domcontentloaded" })).status(), 200);
  await page.waitForSelector(gallery, { visible: true });
  assert.deepEqual(await page.$$eval(`${gallery} [data-family]`, nodes => nodes.map(node => node.dataset.family)), familyIds);
  for (const id of familyIds) { await page.waitForSelector(button(`reset-${id}`)); assert.ok(await state(id)); }
  assert.equal(await page.$$eval('[data-plugin-session-surface]', nodes => nodes.length), 0);
  evidence.assertions.push("Built frontend mounts one scroll gallery with all twelve families/fourteen public UI APIs; native target cannot be minted by gallery.");
  const typography = await page.$eval(gallery, root => {
    const note = getComputedStyle(root.querySelector('.ui-showcase-note')), heading = getComputedStyle(root.querySelector('.ui-showcase-heading'));
    const model = getComputedStyle(root.querySelector('[data-example="model-picker"] button'));
    const label = getComputedStyle(root.querySelector('[data-example="model-picker"] button span'));
    return { rootSize: getComputedStyle(document.documentElement).fontSize, note: { family: note.fontFamily, size: note.fontSize, leading: note.lineHeight, configuredFamily: note.getPropertyValue('--font-prose').trim(), configuredSize: note.getPropertyValue('--lh-prose-size').trim(), configuredLeading: note.getPropertyValue('--lh-prose-leading').trim() }, heading: { family: heading.fontFamily, size: heading.fontSize, transform: heading.textTransform, spacing: heading.letterSpacing }, model: { family: model.fontFamily, size: model.fontSize, labelSize: label.fontSize } };
  });
  assert.equal(typography.model.size, '11px'); assert.equal(typography.model.labelSize, '11px');
  assert.equal(typography.heading.transform, 'uppercase'); assert.ok(parseFloat(typography.heading.spacing) > 0);
  assert.ok(parseFloat(typography.heading.size) <= parseFloat(typography.note.size));
  assert.ok(typography.note.configuredFamily && typography.note.configuredSize && typography.note.configuredLeading, 'Reading typography must use configured host prose tokens');
  const normalizedFamily = value => value.replace(/["']/g, '').replace(/\s+/g, '').toLowerCase();
  assert.equal(normalizedFamily(typography.note.family), normalizedFamily(typography.note.configuredFamily));
  assert.equal(normalizedFamily(typography.model.family), normalizedFamily(typography.heading.family), 'Model pill explicitly uses the compact UI font, not reading typography');
  const tokenPx = (token, relative) => parseFloat(token) * (token.endsWith('rem') ? parseFloat(typography.rootSize) : token.endsWith('px') ? 1 : relative);
  assert.ok(Math.abs(parseFloat(typography.note.size) - tokenPx(typography.note.configuredSize, parseFloat(typography.rootSize))) < .1);
  assert.ok(Math.abs(parseFloat(typography.note.leading) - tokenPx(typography.note.configuredLeading, parseFloat(typography.note.size))) < .1);
  evidence.typography = typography;
  await screenshot('gallery-top', { fullPage: false });

  evidence.stage = "Directory / tree gallery";
  const treeRoot = `${example('tree')} [data-plugin-tree]`;
  const treeRow = key => `${treeRoot} [data-plugin-tree-row="${key}"]`;
  const treeCheckbox = key => `${treeRow(key)} input[data-plugin-tree-control="selection"]`;
  const treeDisclosure = key => `${treeRow(key)} button[data-plugin-tree-control="disclosure"]`;
  const directoryDraft = `${example('tree')} input[aria-label="Directory draft"]`;
  const treeDefaults = { selectionEnabled: false, selectedOccurrenceKeys: [], expanded: { 'example-folder': true, 'another-folder': true }, draft: 'Local draft', lastCallback: 'none' };
  const selectedOccurrences = () => state('tree').then(value => [...value.selectedOccurrenceKeys].sort());
  const treeActive = () => page.$eval(treeRoot, root => root.querySelector('[data-plugin-tree-active="true"]')?.getAttribute('data-plugin-tree-row') ?? null);
  const settleTree = async () => {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForFunction(selector => {
      const root = document.querySelector(selector), sidebar = document.querySelector('aside');
      if (!root) return false;
      const running = document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
      const key = JSON.stringify([root, sidebar].map(node => { if (!node) return null; const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height]; }));
      const last = window.__showcaseTreeSettled;
      window.__showcaseTreeSettled = { key, count: !running && last?.key === key ? last.count + 1 : 0 };
      return !running && window.__showcaseTreeSettled.count >= 3;
    }, { polling: 'raf' }, treeRoot);
    await settlePaint();
  };
  const treeColumns = () => page.$eval(treeRoot, root => {
    const box = node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return { x: rect.x, left: rect.left, right: rect.right, width: rect.width, align: style.textAlign, fontSize: style.fontSize }; };
    return { width: root.getBoundingClientRect().width, columns: [...root.querySelectorAll('[data-plugin-tree-column]')].map(header => ({ key: header.getAttribute('data-plugin-tree-column'), label: header.textContent.trim(), ...box(header) })), rows: [...root.querySelectorAll('[data-plugin-tree-row]')].map(row => ({ key: row.getAttribute('data-plugin-tree-row'), cells: Object.fromEntries([...row.querySelectorAll('[data-plugin-tree-cell]')].map(cell => [cell.getAttribute('data-plugin-tree-cell'), box(cell)])) })) };
  });
  const assertTreeColumns = geometry => {
    assert.deepEqual(geometry.columns.map(column => [column.label, column.width]), [['Kind', 56], ['State', 80]]);
    for (const row of geometry.rows) for (const header of geometry.columns) {
      const cell = row.cells[header.key]; assert.ok(cell);
      for (const edge of ['x', 'left', 'right', 'width']) assert.equal(cell[edge], header[edge], `Directory ${row.key}/${header.key} aligns ${edge}`);
      assert.equal(cell.fontSize, '11px');
    }
  };
  // Detached controls cannot receive trusted browser input. Dispatch solely to
  // prove their expired content/family callbacks cannot mutate the live family.
  const mutateDetachedDraft = handle => handle.evaluate(node => {
    node.value = 'Forbidden expired Directory draft';
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitState('tree', treeDefaults); await settleTree();
  assert.equal(await page.$eval('[data-family="tree"] h2', node => node.textContent), 'Directory / tree');
  assert.equal(await treeActive(), null, 'Directory does not autofocus on mount');
  assert.equal(await page.$$eval(`${treeRoot} input[type="checkbox"]`, nodes => nodes.length), 0);
  assert.equal(await page.$eval(button('toggle-tree-selection'), node => node.textContent), 'Enable selection');
  const guides = () => page.$$eval(`${treeRoot} [aria-hidden="true"]`, nodes => nodes.filter(node => getComputedStyle(node).position === 'absolute' && getComputedStyle(node).width === '1px').map(node => getComputedStyle(node).left));
  assert.ok((await guides()).includes('19px'));
  const primaryLeft = await page.$eval(`${treeRow('example-folder')} > div`, node => node.getBoundingClientRect().left);
  const initialColumns = await treeColumns(); assertTreeColumns(initialColumns);
  await page.$eval('[data-family="tree"]', node => node.scrollIntoView({ block: 'start' }));
  await screenshot('gallery-directory-no-selection', { fullPage: false });
  await fill(directoryDraft, 'Retained Directory learner draft'); await waitState('tree', { draft: 'Retained Directory learner draft' });
  const retainedTreeDraft = await page.$(directoryDraft); assert.ok(retainedTreeDraft);
  await click('toggle-tree-selection'); await waitState('tree', { selectionEnabled: true }); await settleTree();
  assert.equal(await page.$eval(button('toggle-tree-selection'), node => node.textContent), 'Disable selection');
  assert.equal(await page.$eval(`${treeRow('example-folder')} > div`, node => node.getBoundingClientRect().left), primaryLeft + 18);
  assert.ok((await guides()).includes('37px'));
  await page.locator(treeCheckbox('example-folder/shared-item')).click(); await settleTree();
  assert.deepEqual(await selectedOccurrences(), ['example-folder/shared-item']);
  assert.equal(await page.$eval(treeCheckbox('another-folder/shared-item'), node => node.checked), false, 'Repeated Shared item occurrences are independent');
  assert.equal(await page.$eval(treeCheckbox('example-folder'), node => node.checked), false, 'Child selection never auto-selects the parent');
  await page.locator(treeCheckbox('example-folder')).click(); await settleTree();
  assert.deepEqual(await selectedOccurrences(), ['example-folder', 'example-folder/shared-item']);
  assert.equal(await page.$eval(treeCheckbox('example-folder/draft-note'), node => node.checked), false, 'Parent checkbox never cascades to children');
  assert.equal(await retainedTreeDraft.evaluate((node, selector) => node.isConnected && node === document.querySelector(selector) && node.value === 'Retained Directory learner draft', directoryDraft), true, 'Rich content keeps DOM/draft through selection and metadata updates');
  await page.$eval('[data-family="tree"]', node => node.scrollIntoView({ block: 'start' }));
  await screenshot('gallery-directory-selection-independent', { fullPage: false });
  await click('toggle-tree-selection'); await waitState('tree', { selectionEnabled: false });
  assert.equal(await page.$$eval(`${treeRoot} input[type="checkbox"]`, nodes => nodes.length), 0);
  assert.deepEqual(await selectedOccurrences(), ['example-folder', 'example-folder/shared-item'], 'Hiding checkboxes preserves selected occurrence keys');
  await click('toggle-tree-selection'); await waitState('tree', { selectionEnabled: true });
  for (const key of ['example-folder', 'example-folder/shared-item']) assert.equal(await page.$eval(treeCheckbox(key), node => node.checked), true);
  await page.focus(directoryDraft);
  const inputArrowActive = await treeActive(); await page.keyboard.press('ArrowLeft');
  assert.equal(await retainedTreeDraft.evaluate(node => node === document.activeElement), true);
  assert.equal(await treeActive(), inputArrowActive, 'Editable input arrows do not navigate rows');
  await retainedTreeDraft.evaluate(node => { window.__showcaseTreeTab = []; node.addEventListener('keydown', event => { if (event.key === 'Tab') queueMicrotask(() => window.__showcaseTreeTab.push({ defaultPrevented: event.defaultPrevented })); }); });
  await page.keyboard.press('Tab');
  assert.equal(await retainedTreeDraft.evaluate(node => node === document.activeElement), true, 'Global Tab policy is unchanged');
  assert.deepEqual(await page.evaluate(() => window.__showcaseTreeTab), [{ defaultPrevented: true }]);
  const navigateDirectory = async (key, expected) => { await page.keyboard.press(key); await settleTree(); assert.equal(await treeActive(), expected); assert.equal(await page.$eval(treeRow(expected), node => node === document.activeElement), true); };
  await page.locator(`${treeRow('example-folder')} > div`).click();
  await navigateDirectory('ArrowDown', 'another-folder'); await navigateDirectory('ArrowUp', 'example-folder');
  await navigateDirectory('ArrowRight', 'example-folder/shared-item'); await navigateDirectory('ArrowDown', 'example-folder/draft-note');
  await navigateDirectory('ArrowLeft', 'example-folder');
  assert.equal((await state('tree')).expanded['example-folder'], false);
  assert.equal(await retainedTreeDraft.evaluate(node => node.isConnected), false, 'Controlled fold unmounts rich content');
  await page.$eval('[data-family="tree"]', node => node.scrollIntoView({ block: 'start' }));
  await screenshot('gallery-directory-controlled-collapse', { fullPage: false });
  const foldedState = await state('tree'); await mutateDetachedDraft(retainedTreeDraft); await settlePaint();
  assert.deepEqual(await state('tree'), foldedState, 'Folded content listeners/callbacks are cleaned or aborted');
  await navigateDirectory('ArrowRight', 'example-folder/shared-item');
  await waitState('tree', { draft: 'Retained Directory learner draft' });
  assert.equal(await page.$eval(directoryDraft, node => node.value), 'Retained Directory learner draft', 'Caller draft survives content remount');
  await page.$eval('[data-family="tree"]', node => node.scrollIntoView({ block: 'start' }));
  await screenshot('gallery-directory-reopened-retained-draft', { fullPage: false });
  await retainedTreeDraft.dispose();
  const selectionBeforeSpace = await selectedOccurrences();
  await page.keyboard.press('Space'); await settleTree();
  assert.deepEqual(await selectedOccurrences(), selectionBeforeSpace.filter(key => key !== 'example-folder/shared-item'), 'Space toggles only the active occurrence');
  const withSelectionColumns = await treeColumns(); assertTreeColumns(withSelectionColumns);
  const directoryViewport = page.viewport();
  await page.setViewport({ width: 850, height: 1000, deviceScaleFactor: 1 }); await settleTree();
  const compactColumns = await treeColumns(); assertTreeColumns(compactColumns);
  const minimumTreeWidth = await page.evaluate(() => 36 * parseFloat(getComputedStyle(document.documentElement).fontSize));
  assert.equal(compactColumns.width, minimumTreeWidth, 'Caller supplies its 36rem minimum, not automatic Tree responsiveness');
  const horizontalWrap = await page.$eval(treeRoot, root => {
    let node = root.parentElement;
    while (node && !/auto|scroll/.test(getComputedStyle(node).overflowX)) node = node.parentElement;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, scrollLeft: node.scrollLeft, overflowX: getComputedStyle(node).overflowX, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  assert.ok(horizontalWrap && horizontalWrap.scrollWidth > horizontalWrap.clientWidth, 'Caller supplies a genuinely overflowing horizontal wrapper');
  await page.$eval('[data-family="tree"]', node => node.scrollIntoView({ block: 'start' }));
  await screenshot('gallery-directory-caller-scroll', { fullPage: false });
  await page.setViewport(directoryViewport); await settleTree();
  evidence.directoryColumns = { initial: initialColumns, selection: withSelectionColumns, compact: compactColumns, horizontalWrap };
  await click('button-variant-default'); await waitState('buttons', { clicks: 1 });
  const siblingBeforeTreeReset = await state('buttons');
  const expiredDraft = await page.$(directoryDraft), expiredCheckbox = await page.$(treeCheckbox('example-folder')), expiredDisclosure = await page.$(treeDisclosure('example-folder')); assert.ok(expiredDraft && expiredCheckbox && expiredDisclosure);
  await reset('tree'); await waitState('tree', treeDefaults);
  assert.deepEqual(await state('buttons'), siblingBeforeTreeReset, 'Reset tree cannot reset a sibling family');
  for (const handle of [expiredDraft, expiredCheckbox, expiredDisclosure]) assert.equal(await handle.evaluate(node => node.isConnected), false, 'Reset disposes old family scope nodes');
  await mutateDetachedDraft(expiredDraft); await expiredCheckbox.evaluate(node => node.click()); await expiredDisclosure.evaluate(node => node.click()); await settlePaint();
  await waitState('tree', treeDefaults);
  await reset('buttons'); await waitState('buttons', { clicks: 0 });
  for (const handle of [expiredDraft, expiredCheckbox, expiredDisclosure]) await handle.dispose();
  await fill(directoryDraft, 'Route-local Directory draft'); await waitState('tree', { draft: 'Route-local Directory draft' });
  const routeExpiredDraft = await page.$(directoryDraft); assert.ok(routeExpiredDraft);
  await page.locator('[data-testid="session-row"]').click();
  await page.waitForFunction(id => location.pathname === `/chat/${id}`, {}, fixture.chatId);
  await page.waitForSelector(gallery, { hidden: true });
  await openGallery(); await waitState('tree', treeDefaults);
  assert.equal(await routeExpiredDraft.evaluate(node => node.isConnected), false);
  await mutateDetachedDraft(routeExpiredDraft); await settlePaint(); await waitState('tree', treeDefaults); await routeExpiredDraft.dispose();
  await reset('tree'); await waitState('tree', treeDefaults);
  evidence.directoryTree = { defaults: treeDefaults, selectionHiddenPreservesKeys: true, occurrenceIndependent: true, controlledDraftRetainedAcrossCollapse: true, stableRichContentDuringMetadataUpdates: true, nativeArrowAndSpace: true, hostTabUnchanged: true, resetAndRouteExpiredNodesInert: true, siblingResetIsolation: true };
  evidence.assertions.push('Actual public Directory/tree gallery: optional selection preserves hidden keys with no occurrence/parent cascade; rich content keeps DOM/draft through metadata updates and restores local draft after fold; native root arrows/Space isolate input keys and preserve global Tab; two compact columns align by x/left/right at every depth within a caller-owned 36rem horizontal wrapper; Reset isolates sibling state and aborts old control callbacks; real sidebar navigation remounts defaults. Synthetic graph untouched.');

  evidence.stage = "buttons";
  for (const variant of ["default", "destructive", "outline", "secondary", "ghost", "link"]) { await click(`button-variant-${variant}`); }
  for (const size of ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"]) { await click(`button-size-${size}`); }
  await waitState("buttons", { clicks: 14 });
  assert.equal(await page.$eval(button("button-disabled"), node => node.disabled), true);
  await click("button-async"); await waitState("buttons", { pending: true });
  await click("complete-button-async"); await waitState("buttons", { pending: false });
  await click("button-async"); await waitState("buttons", { pending: true });
  await reset("buttons"); await waitState("buttons", { pending: false, clicks: 0 });
  evidence.assertions.push("All six Button variants/eight sizes are native controls; manual async completion and pending-family-reset settle without a timer.");

  evidence.stage = "settings validation";
  const setting = key => `${example("settings-rows")} [data-plugin-setting="${key}"]`;
  const textField = `${setting("text")} input`;
  await fill(textField, "ab"); await page.keyboard.press("Enter");
  await page.waitForSelector(`${setting("text")} [role="alert"]`, { visible: true });
  assert.equal((await state("settings")).text, "Example");
  await fill(textField, "Local accepted text"); await page.keyboard.press("Enter");
  await waitState("settings", { text: "Local accepted text" });
  await page.locator(`${setting("toggle")} [role="switch"]`).click(); await waitState("settings", { enabled: false });
  await page.select(`${setting("dropdown")} select`, "second"); await waitState("settings", { choice: "second" });
  await fill(`${setting("number")} input`, "11"); await page.keyboard.press("Enter");
  await page.waitForSelector(`${setting("number")} [role="alert"]`, { visible: true });
  assert.equal((await state("settings")).count, 3);
  await fill(`${setting("number")} input`, "7"); await page.keyboard.press("Enter"); await waitState("settings", { count: 7 });
  const slider = `${setting("slider")} input[type="range"]`;
  const sliderNode = await page.$(slider);
  await sliderNode.scrollIntoView();
  const rangeBox = await sliderNode.boundingBox(); assert.ok(rangeBox && rangeBox.width > 40);
  await sliderNode.evaluate(node => {
    window.__showcaseRangeMutations = [];
    window.__showcaseRangeObserver = new MutationObserver(entries => window.__showcaseRangeMutations.push(...entries.map(entry => ({ oldValue: entry.oldValue, disabled: node.disabled }))));
    window.__showcaseRangeObserver.observe(node, { attributes: true, attributeFilter: ['disabled'], attributeOldValue: true });
  });
  const rangeX = value => rangeBox.x + 8 + (rangeBox.width - 16) * value / 100;
  const dragSamples = [];
  await page.mouse.move(rangeX(50), rangeBox.y + rangeBox.height / 2); await page.mouse.down();
  try {
    for (const target of [52, 44, 36, 26, 16]) {
      await page.mouse.move(rangeX(target), rangeBox.y + rangeBox.height / 2, { steps: 4 }); await settlePaint();
      dragSamples.push(await sliderNode.evaluate((node, selector) => ({ value: Number(node.value), disabled: node.disabled, sameNode: node === document.querySelector(selector), localAmount: JSON.parse(document.querySelector('[data-state="settings"]').textContent).amount }), slider));
    }
  } finally { await page.mouse.up(); }
  const disabledMutations = await page.evaluate(() => { window.__showcaseRangeObserver.disconnect(); return window.__showcaseRangeMutations; });
  evidence.continuousSlider = { samples: dragSamples, disabledMutations };
  assert.ok(dragSamples.every(sample => sample.sameNode && !sample.disabled && sample.value === sample.localAmount), 'One live native range node remains enabled and locally acknowledged during the held drag');
  assert.ok(dragSamples[0].value > 50 && dragSamples.at(-1).value < 25, 'Trusted held drag progresses past the former 50→52 disabled stall');
  assert.ok(new Set(dragSamples.map(sample => sample.value)).size >= 4, 'Continuous drag must generate repeated value progress, not just keyboard/single click');
  assert.deepEqual(disabledMutations, [], 'Synchronous callbacks must never transiently disable the slider');
  await sliderNode.dispose();
  await page.focus(slider); await page.keyboard.press('ArrowRight');
  assert.ok((await state('settings')).amount > dragSamples.at(-1).value);
  assert.equal(await page.$eval(`${setting("disabled")} input`, node => node.disabled), true);
  await reset("settings"); await waitState("settings", { enabled: true, text: "Example", choice: "first", count: 3, amount: 50 });
  evidence.assertions.push("Real host settings rows exercise five types, validation rejection, controlled acknowledgment, disabled row/local reset, and trusted continuous native slider drag with repeated progress, stable node identity and zero transient disabled mutations.");

  evidence.stage = "real pickers";
  await page.locator(`${example("model-picker")} button[aria-label="Model selector"]`).click();
  await page.waitForSelector('[data-testid="plugin-model-menu"]', { visible: true });
  await page.$$eval('[data-testid="plugin-model-menu"] button', (nodes, model) => { const chosen = nodes.find(node => node.textContent.includes(model)); if (!chosen) throw Error("Offline model missing"); chosen.click(); }, fixture.model);
  await waitState("pickers", { model: { provider: "custom", id: fixture.model } });
  await page.locator(`${example("thinking-picker")} button[aria-label="Thinking"]`).click();
  await page.waitForSelector('[data-testid="thinking-option-high"]', { visible: true });
  await page.locator('[data-testid="thinking-option-high"]').click(); await waitState("pickers", { thinking: "high" });
  const knowledge = '[data-testid="chain-table-overlay"]';
  const knowledgeGeometry = async (mode, label) => {
    await page.waitForSelector(`${knowledge} [data-testid="add-source-folder"]`, { visible: true }); await settlePaint();
    const geometry = await page.$eval(knowledge, overlay => {
      const box = node => { const { x, y, width, height, right, bottom } = node.getBoundingClientRect(); return { x, y, width, height, right, bottom }; };
      const main = document.querySelector('main'), sidebar = document.querySelector('aside'), header = overlay.querySelector('header');
      const semantic = overlay.closest('[data-interaction-layer]');
      const counts = [...header.children].find(node => /1 chain.*2 nodes/.test(node.textContent));
      const side = box(sidebar), hit = side.width > 1 ? document.elementFromPoint(side.x + side.width / 2, 150) : null;
      return { overlay: box(overlay), main: box(main), sidebar: side, header: box(header), counts: counts ? box(counts) : null,
        close: box(overlay.querySelector('[data-testid="chain-table-close"]')), viewport: { x: 0, y: 0, width: innerWidth, height: innerHeight },
        modal: semantic?.getAttribute('aria-modal') === 'true', role: semantic?.getAttribute('role'), layer: semantic?.getAttribute('data-interaction-layer'),
        sidebarInert: !!sidebar.closest('[inert],[aria-hidden="true"]'), sidebarHit: !!hit && sidebar.contains(hit),
        sidebarToggles: overlay.querySelectorAll('[aria-label="Open sidebar"],[aria-label="Close sidebar"]').length,
        doneText: overlay.querySelector('[data-testid="chain-practice-done"]')?.textContent.trim(), doneIcons: overlay.querySelectorAll('[data-testid="chain-practice-done"] svg').length };
    });
    const expected = mode === 'main' ? geometry.main : geometry.viewport;
    for (const axis of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(geometry.overlay[axis] - expected[axis]) <= 1, `${label}: picker ${axis} must match ${mode === 'main' ? 'actual main-pane view' : 'full viewport'}`);
    assert.equal(geometry.modal, mode === 'modal', `${label}: origin controls interaction semantics`);
    assert.equal(geometry.sidebarToggles, 0, 'No sidebar toggle inside the picker');
    assert.equal(geometry.doneIcons, 0, 'Knowledge Done has no icon');
    if (geometry.doneText !== undefined) assert.match(geometry.doneText, /Done/i); // Native selection footer exists only for a nonempty selection.
    assert.equal(await page.$('[data-plugin-knowledge-picker-pane]') !== null, mode === 'main', 'Only page/session origins use the local main-pane picker root');
    if (geometry.sidebar.width > 1) { assert.equal(geometry.sidebarInert, mode === 'modal'); assert.equal(geometry.sidebarHit, mode === 'main'); }
    assert.equal(await paintedTop(knowledge), true, `${label}: the newest picker must actually paint above older views`);
    (evidence.knowledgeOrigins ??= []).push({ label, mode, ...geometry }); return geometry;
  };
  const closeKnowledge = async () => {
    const selected = await page.$(`${knowledge} [data-testid="chain-practice-done"]`);
    await page.locator(`${knowledge} [data-testid="${selected ? 'chain-practice-done' : 'chain-table-close'}"]`).click();
    await page.waitForSelector(knowledge, { hidden: true });
  };
  await page.locator(`${example("knowledge-picker")} [data-testid="practice-props-chip"]`).click();
  await page.waitForSelector(knowledge, { visible: true });
  await knowledgeGeometry('main', 'gallery origin/sidebar open');
  await screenshot('knowledge-page-sidebar-open', { fullPage: false });
  const cluster = `${knowledge} [data-testid="cluster-toggle-${fixture.sourceId}"]`;
  await page.waitForSelector(cluster);
  if (await page.$eval(cluster, node => node.getAttribute("aria-expanded")) !== "true") await page.locator(cluster).click();
  await page.locator(`${knowledge} [data-testid="chain-checkbox-${fixture.chainId}"]`).click();
  await waitState("pickers", { knowledge: [fixture.premiseId, fixture.conclusionId] });
  assert.match(await page.$eval(`${knowledge} [data-testid="chain-practice-done"]`, node => node.textContent), /Done/i);
  assert.equal(await page.$$eval(`${knowledge} [data-testid="chain-practice-done"] svg`, nodes => nodes.length), 0, 'Selected native Done is label-only');
  await page.locator(`${knowledge} [data-testid="chain-practice-done"]`).click(); await page.waitForSelector(knowledge, { hidden: true });
  await page.locator(`${example("knowledge-picker")} [data-testid="practice-props-chip"]`).click();
  await page.waitForSelector(knowledge, { visible: true }); await page.keyboard.press("Escape"); await page.waitForSelector(knowledge, { hidden: true });
  assert.deepEqual((await state("pickers")).knowledge, [fixture.premiseId, fixture.conclusionId]);
  assert.match(await page.$eval('[data-family="pickers"]', node => node.textContent), /source.*(management|organiz|edit)|renam|real.*sources/i);
  await reset("pickers"); await waitState("pickers", { model: null, thinking: null, knowledge: [] });
  evidence.assertions.push("Actual model/thinking and contextual knowledge picker update plugin-local values; gallery-origin picker fills only main-pane view and leaves sidebar interactive. Synthetic selection survives Done/reopen/Escape; no automated source editing.");

  evidence.stage = 'knowledge origin scopes';
  const nativeEnvironment = await page.evaluate(() => ({ className: document.documentElement.className, platform: document.documentElement.getAttribute('data-lh-platform'), style: document.documentElement.getAttribute('style') }));
  const sidebarOpen = () => page.$eval('aside', node => node.getBoundingClientRect().width > 1);
  const setSidebar = async open => {
    if ((await sidebarOpen()) !== open) await chord('b');
    await page.waitForFunction(open => open ? document.querySelector('aside').getBoundingClientRect().width > 250 : document.querySelector('aside').getBoundingClientRect().width < 1, {}, open);
    await page.waitForFunction(() => document.querySelector('aside').getAnimations().every(animation => animation.playState !== 'running'));
    await settlePaint();
  };
  const setNativeEnvironment = ({ platform, zoom, right = 0 }) => page.evaluate(({ platform, zoom, right }) => {
    const root = document.documentElement; root.classList.add('lh-electron'); root.dataset.lhPlatform = platform;
    root.style.setProperty('--lh-zoom', String(zoom));
    if (right) root.style.setProperty('--lh-wco-right', `${right}px`); else root.style.removeProperty('--lh-wco-right');
  }, { platform, zoom, right });
  for (const simulation of [{ platform: 'darwin', zoom: 1 }, { platform: 'darwin', zoom: 1.5 }, { platform: 'win32', zoom: 1.5, right: 138 }, { platform: 'linux', zoom: 1.5, right: 138 }]) {
    await setNativeEnvironment(simulation);
    for (const open of [true, false]) {
      await setSidebar(open);
      const before = await page.$eval('aside', node => node.getBoundingClientRect().width);
      await page.locator(`${example('knowledge-picker')} [data-testid="practice-props-chip"]`).click();
      await page.waitForSelector(knowledge, { visible: true });
      const geometry = await knowledgeGeometry('main', `simulated ${simulation.platform}/zoom ${simulation.zoom}/sidebar ${open ? 'open' : 'closed'}`);
      if (simulation.platform === 'darwin' && !open) assert.ok(geometry.counts.x >= 92 / simulation.zoom - 1, 'Closed-sidebar picker counts clear simulated macOS traffic-light area at published zoom');
      if (simulation.right) assert.ok(geometry.header.right - geometry.close.right >= simulation.right + 10, 'Right controls clear simulated native window-controls area without double zoom division');
      assert.ok(Math.abs(geometry.sidebar.width - before) <= 1, 'Opening a picker must not change background sidebar state');
      await closeKnowledge();
    }
  }
  evidence.windowControlCss = await page.evaluate(() => {
    const found = []; const visit = rules => { for (const rule of rules) { if (rule.cssRules) visit(rule.cssRules); if (rule.cssText?.includes('--lh-wco-right')) found.push(rule.cssText); } };
    for (const sheet of document.styleSheets) { try { visit(sheet.cssRules); } catch {} } return found;
  });
  assert.ok(evidence.windowControlCss.some(rule => /--lh-wco-right/.test(rule) && /env\(titlebar-area-x/.test(rule) && /env\(titlebar-area-width/.test(rule) && !/--lh-zoom/.test(rule)), 'Loaded product CSS preserves native env() window-control math without another zoom division');
  await page.evaluate(saved => { const root = document.documentElement; root.className = saved.className; if (saved.platform === null) root.removeAttribute('data-lh-platform'); else root.setAttribute('data-lh-platform', saved.platform); if (saved.style === null) root.removeAttribute('style'); else root.setAttribute('style', saved.style); }, nativeEnvironment);
  await setSidebar(true);
  await page.locator(`${example('knowledge-picker')} [data-testid="practice-props-chip"]`).click(); await page.waitForSelector(knowledge, { visible: true });
  await page.locator('[data-testid="session-row"]').click();
  await page.waitForFunction(id => location.pathname === `/chat/${id}`, {}, fixture.chatId);
  await page.waitForSelector(knowledge, { hidden: true }); await page.waitForSelector('[data-plugin-knowledge-picker-pane]', { hidden: true });
  await openGallery();
  evidence.contextRouteExpiry = true;
  evidence.notExercised = ['No visible production control opens a newer surface over an already open main-pane picker. Reverse programmatic ordering belongs to the separately owned host integration test; this browser proof does not invent a hidden-control user path.', 'Window-controls cases simulate published native CSS environment/zoom contracts, not actual Windows/Linux OS chrome.', 'No microphone recording or OS IME testing.'];
  evidence.assertions.push('Contextual picker bounds follow actual open/closed sidebar; simulated macOS zoom gutters and Windows/Linux right window-controls clearance pass. Simulation checks CSS geometry only—not physical Windows/Linux OS buttons. Picker never toggles background sidebar, Done has no icon, and real sidebar session navigation expires the open picker.');

  evidence.stage = "local composers and idle dictation";
  const composition = await page.$eval(example('standard-composer'), root => {
    const preset = root.querySelector('[data-plugin-standard-composer]'), form = preset.querySelector('form'), frame = form.parentElement;
    const controls = preset.querySelector('[data-testid="plugin-dictation-control"]').parentElement;
    const b = node => { const { y, bottom } = node.getBoundingClientRect(); return { y, bottom }; };
    return { frameContainsControls: frame.contains(controls), frameBorder: getComputedStyle(frame).borderTopWidth, outerBorder: getComputedStyle(preset).borderTopWidth, frame: b(frame), controls: b(controls) };
  });
  assert.equal(composition.frameContainsControls, false); assert.equal(composition.outerBorder, '0px');
  assert.ok(parseFloat(composition.frameBorder) > 0); assert.ok(composition.controls.y >= composition.frame.bottom - 1, 'Standard controls are below and outside the text-only frame');
  assert.equal(await page.$eval(`${example('composer')} form`, node => getComputedStyle(node).borderTopWidth), '0px', 'Standalone composer remains bare');
  evidence.standardComposerLayout = composition;
  for (const id of ["composer", "standard-composer"]) {
    const field = `${example(id)} [contenteditable="true"]`;
    await fill(field, `Local ${id} draft`); await waitState(id, { draft: `Local ${id} draft` });
    await page.locator(`${example(id)} button[aria-label="Send"]`).click(); await waitState(id, { busy: true, sends: 1 });
    // Native Composer intentionally retains Send while a busy draft is nonempty
    // (steering semantics). Clear via trusted input to expose its actual Stop.
    await fill(field, ""); await waitState(id, { draft: "" });
    await page.locator(`${example(id)} button[aria-label="Stop"]`).click(); await waitState(id, { busy: false });
    await fill(field, `Second local ${id} draft`);
    await page.locator(`${example(id)} button[aria-label="Send"]`).click(); await waitState(id, { busy: true, sends: 2 });
    await click(`complete-${id}`); await waitState(id, { busy: false });
    await reset(id); await waitState(id, { draft: "", sends: 0 });
  }
  for (const id of ["dictation", "standard-composer"]) {
    assert.equal(await page.$$eval(`${example(id)} [data-testid="dictation-meter"]`, nodes => nodes.length), 0);
    assert.equal(await page.$eval(`${example(id)} [data-testid="dictation-toggle"]`, node => node.getAttribute("aria-label")), "Start dictation");
  }
  await waitState("dictation", { deliveries: 0, transcript: "" });
  await page.$eval('[data-family="composer"]', node => node.scrollIntoView({ block: 'start' }));
  await screenshot('gallery-composers', { fullPage: false });
  evidence.assertions.push("Both actual host composers echo local controlled drafts and simulate Send/Stop/Complete/reset without /api/chat. Native Stop is exposed after clearing a busy retained draft (nonempty draft intentionally remains Send). Dictation remains idle with no recording meter and zero delivery; microphone never clicked. OS IME not tested.");

  evidence.stage = "Markdown and static workers";
  await page.waitForSelector(`${example("markdown")} table`);
  await page.waitForSelector(`${example("markdown")} .katex`);
  await page.waitForFunction(selector => !!document.querySelector(selector)?.querySelector('svg[id^="lh-mermaid"], [data-testid="mermaid-render"] svg, .mermaid svg'), {}, example("markdown"));
  assert.ok(await page.$eval(`${example("markdown")} pre code`, node => node.textContent.includes("Hello, gallery")));
  for (const status of ["succeeded", "failed", "cancelled", "interrupted"]) {
    for (const presentation of ["collapsed", "card", "plain"]) {
      const slot = example(`worker-${status}-${presentation}`);
      const testid = presentation === "collapsed" ? "plugin-worker-result" : `plugin-worker-result-${presentation}`;
      await page.waitForSelector(`${slot} [data-testid="${testid}"]`);
      const header = `${slot} [data-testid="plugin-worker-header"]`;
      const worker = await page.$eval(header, node => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), visible = [];
        for (let text; (text = walker.nextNode());) if (!text.parentElement.closest('.sr-only,[aria-hidden="true"]')) visible.push(text.textContent);
        return { text: node.textContent, visible: visible.join('').trim(), title: node.getAttribute('title'), tooltipTrigger: node.getAttribute('data-slot'), icons: [...node.querySelectorAll('svg')].map(icon => ({ class: icon.getAttribute('class'), hidden: icon.getAttribute('aria-hidden') })), srText: [...node.querySelectorAll('.sr-only')].map(text => text.textContent).join(' ') };
      });
      assert.equal(worker.visible, 'Example worker', 'Only worker label is visibly written in the outcome header');
      assert.doesNotMatch(worker.visible, /Background result|succeeded|failed|cancelled|interrupted|view result|hide result/i);
      assert.match(worker.srText, new RegExp(status, 'i')); assert.equal(worker.icons[0].hidden, 'true');
      assert.equal(worker.title, null, 'Use the app Hint rather than a second browser title tooltip');
      assert.equal(worker.tooltipTrigger, 'tooltip-trigger');
      await page.locator(header).hover();
      await page.waitForFunction(({ header, status }) => {
        const ids = document.querySelector(header).getAttribute('aria-describedby')?.split(/\s+/) ?? [];
        return ids.some(id => { const tip = document.getElementById(id); return tip?.matches('[role="tooltip"][data-slot="tooltip-content"]') && tip.textContent === `Example worker: ${status}`; });
      }, {}, { header, status });
      const tooltip = await page.$eval(header, trigger => { const id = trigger.getAttribute('aria-describedby'); const tip = document.getElementById(id); return { id, text: tip.textContent, role: tip.getAttribute('role'), slot: tip.getAttribute('data-slot') }; });
      assert.equal(await paintedTop('[role="tooltip"][data-slot="tooltip-content"]'), true, 'Actual app tooltip is painted and described by its outcome header');
      await page.mouse.move(1, 1);
      (evidence.workerOutcomes ??= []).push({ status, presentation, tooltip, ...worker });
      if (presentation === "collapsed") {
        assert.ok(worker.icons.some(icon => /chevron/i.test(icon.class)), 'Collapsed outcome uses a disclosure chevron without view/hide words');
        await page.locator(`${slot} summary`).click(); assert.equal(await page.$eval(`${slot} details`, node => node.open), true);
        await page.waitForFunction(selector => document.querySelector(selector).textContent.includes("No worker was run."), {}, slot);
      }
    }
  }
  await page.$eval('[data-family="worker-results"]', node => node.scrollIntoView({ block: 'start' }));
  await screenshot("worker-outcomes-viewport", { fullPage: false });
  evidence.assertions.push("Builtin Markdown renders prose/code/table/math/Mermaid; all twelve static worker outcomes show only the label and outcome icon, retain full screen-reader/hover-tooltip outcome, and collapsed results use a chevron, without starting tasks.");

  evidence.stage = "menus and dialogs";
  await click("menu-down"); await page.waitForSelector('[data-testid="plugin-menu"]', { visible: true });
  assert.equal(await page.$eval('[data-testid="plugin-menu"] [role="menuitem"]:disabled', node => node.textContent), "Disabled example");
  await page.$$eval('[data-testid="plugin-menu"] [role="menuitem"]', nodes => nodes.find(node => node.textContent === "Select second example").click());
  await waitState("menus", { selection: "second" });
  await click("menu-up"); await page.waitForSelector('[data-testid="plugin-menu"]', { visible: true }); await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="plugin-menu"]', { hidden: true });
  await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, button("menu-up"));
  await click("dialog-nested");
  const parentDialog = '[data-showcase="dialog-nested"]';
  const dialogField = `${parentDialog} input[aria-label="Retained text"]`;
  await page.waitForSelector(dialogField, { visible: true });
  assertOverlayChrome(await overlayChrome(parentDialog, 'Parent dialog example'));
  await fill(dialogField, "Retained dialog draft"); await page.keyboard.press("Enter");
  const parentInput = await page.$(dialogField);
  await page.locator(button("dialog-nested-child", parentDialog)).click(); await page.waitForSelector('[data-showcase="dialog-ordinary"]', { visible: true });
  assertOverlayChrome(await overlayChrome('[data-showcase="dialog-ordinary"]', 'Ordinary dialog example'));
  await page.locator(`${example('dialog-ordinary-knowledge-picker', '[data-showcase="dialog-ordinary"]')} [data-testid="practice-props-chip"]`).click();
  await page.waitForSelector(knowledge, { visible: true }); await knowledgeGeometry('modal', 'knowledge from nested ordinary dialog');
  await screenshot('knowledge-modal-dialog-origin', { fullPage: false });
  await closeKnowledge();
  assert.equal(await page.$eval('[data-showcase="dialog-ordinary"]', node => !node.closest('[inert]')), true, 'Closing full-viewport picker resumes its exact dialog owner');
  assert.equal(await parentInput.evaluate(node => node.isConnected && node.value === "Retained dialog draft" && !!node.closest("[inert]")), true);
  // CommitInput deliberately claims Escape to blur/commit. Focus a native
  // non-editor control when testing the layer's top-only Escape contract.
  await page.focus('[role="dialog"][aria-label="Ordinary dialog example"] button[aria-label="Close dialog"]');
  await page.keyboard.press("Escape"); await page.waitForSelector('[data-showcase="dialog-ordinary"]', { hidden: true });
  assert.equal(await parentInput.evaluate(node => node.isConnected && node.value === "Retained dialog draft" && !node.closest("[inert]")), true);
  await page.keyboard.press("Escape"); await page.waitForSelector(parentDialog, { hidden: true }); await parentInput.dispose();
  await click("dialog-long"); await page.waitForSelector('[data-showcase="dialog-long"]', { visible: true });
  assert.ok(await page.$eval('[data-showcase="dialog-long"]', node => node.textContent.includes("Paragraph 32")));
  evidence.dialogScrolling = await assertPinnedWhileScrolling('[data-showcase="dialog-long"]', 'Long-scroll example');
  await screenshot('dialog-long-pinned-close', { fullPage: false });
  await page.focus('[role="dialog"][aria-label="Long-scroll example"] button[aria-label="Close dialog"]');
  await page.keyboard.press("Escape"); await page.waitForSelector('[data-showcase="dialog-long"]', { hidden: true });
  evidence.assertions.push("Native menus honor disabled items, selection, preferred-side examples and Escape focus return; nested dialogs retain the identical parent input while only top Escape closes; long-scroll content mounts.");

  evidence.stage = "native session surface";
  await page.goto(base + `/chat/${fixture.chatId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('main [data-testid="composer"] [contenteditable="true"]', { visible: true });
  const surface = '[data-showcase="surface"]', nested = '[data-showcase="surface-nested"]';
  const openSurface = async () => {
    const direct = '[data-testid="plugin-top-bar-actions"] [data-plugin-action="ui-showcase/surface-topbar"]';
    await page.waitForFunction(selector => !!document.querySelector(selector) || !!document.querySelector('[aria-label="More plugin actions"]'), {}, direct);
    if (await page.$(direct)) await page.locator(direct).click();
    else { await page.locator('[aria-label="More plugin actions"]').click(); await page.locator('[data-plugin-action="ui-showcase/surface-topbar"]').click(); }
    await page.waitForSelector(surface, { visible: true });
  };
  await openSurface();
  const bounds = await page.$eval('[data-session-surface-region]', node => {
    const box = node => { const { x, y, width, height, right, bottom } = node.getBoundingClientRect(); return { x, y, width, height, right, bottom }; };
    return { region: box(node), frame: box(node.querySelector('[data-plugin-session-surface-frame]')), semanticDisplay: getComputedStyle(node.querySelector('[data-plugin-session-surface]')).display, header: box(document.querySelector("main header")), sidebar: box(document.querySelector("aside")), nativeInputInert: !!document.querySelector('[data-testid="composer"]')?.closest('[inert]') };
  });
  assert.equal(bounds.semanticDisplay, "contents"); assert.ok(bounds.frame.width > 0 && bounds.frame.height > 0);
  for (const dimension of ["x", "y", "width", "height", "right", "bottom"]) assert.ok(Math.abs(bounds.frame[dimension] - bounds.region[dimension]) <= 1, `Actual surface frame must fill body region: ${dimension}`);
  assert.ok(bounds.frame.y >= bounds.header.bottom - 1); assert.ok(bounds.frame.x >= bounds.sidebar.right - 1); assert.equal(bounds.nativeInputInert, true);
  evidence.surfaceBounds = bounds;
  assertOverlayChrome(await overlayChrome(surface, 'UI Showcase surface', true));
  const surfaceRoot = await page.$(surface);
  const surfaceAppearance = () => page.$eval(surface, root => {
    const frame = root.closest('[data-plugin-session-surface-frame]');
    const style = getComputedStyle(frame), contentStyle = getComputedStyle(root);
    const alpha = color => { const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[3] / 255; };
    return { frameAlpha: alpha(style.backgroundColor), backdropFilter: style.backdropFilter, contentAlpha: alpha(contentStyle.backgroundColor), contentBackgroundImage: contentStyle.backgroundImage };
  });
  const dimmed = await surfaceAppearance();
  assert.ok(Math.abs(dimmed.frameAlpha - .8) <= .01); assert.match(dimmed.backdropFilter, /blur/);
  assert.equal(dimmed.contentAlpha, 0, 'Showcase root must not mask translucent surface with an opaque background'); assert.equal(dimmed.contentBackgroundImage, 'none');
  await screenshot('surface-default-dimmed', { fullPage: false });
  await page.locator(button('surface-background-opaque', surface)).click(); await waitState('surfaces', { background: 'opaque' }, surface);
  const opaque = await surfaceAppearance(); assert.equal(opaque.frameAlpha, 1); assert.equal(opaque.backdropFilter, 'none'); assert.equal(opaque.contentAlpha, 0);
  await screenshot('surface-opaque', { fullPage: false });
  assert.equal(await surfaceRoot.evaluate(node => node.isConnected && node === document.querySelector('[data-showcase="surface"]')), true, 'Public background update must retain mounted content');
  await page.locator(button('surface-background-dimmed', surface)).click(); await waitState('surfaces', { background: 'dimmed' }, surface);
  assert.ok(Math.abs((await surfaceAppearance()).frameAlpha - .8) <= .01);
  evidence.surfaceBackgrounds = { dimmed, opaque }; await surfaceRoot.dispose();
  evidence.surfaceScrolling = await assertPinnedWhileScrolling(surface, 'UI Showcase surface', true);
  const surfaceField = `${surface} [data-example="surface-parent-retained-field"] input`;
  await fill(surfaceField, "Retained native surface draft"); await page.keyboard.press("Enter");
  const retained = await page.$(surfaceField);
  const retainedOwner = await retained.evaluate(node => node.closest('[data-plugin-session-surface]').getAttribute('data-interaction-layer'));
  const sessionSettingsBeforeCoveredKeys = (await api(`/api/chats/${fixture.chatId}`)).payload.settings;
  await page.locator(`${example('surface-knowledge-picker', surface)} [data-testid="practice-props-chip"]`).click();
  await page.waitForSelector(knowledge, { visible: true }); await knowledgeGeometry('main', 'knowledge launched from native surface');
  const pickerNode = await page.$(knowledge);
  // A cross-region main-pane VIEW is not a new session surface or a modal:
  // do not impose either one's DOM-inert attribute policy on its source.
  const coveredSource = await retained.evaluate((node, { selector, owner }) => {
    const b = node.getBoundingClientRect(), picker = document.querySelector(selector);
    return { sameNode: node === document.querySelector('[data-example="surface-parent-retained-field"] input'), connected: node.isConnected, draft: node.value,
      owner: node.closest('[data-plugin-session-surface]').getAttribute('data-interaction-layer'),
      pickerOwnsSourcePoint: picker.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)), expectedOwner: owner };
  }, { selector: knowledge, owner: retainedOwner });
  assert.equal(coveredSource.pickerOwnsSourcePoint, true, 'Newer picker actually covers the older source field');
  assert.equal(coveredSource.sameNode && coveredSource.connected, true); assert.equal(coveredSource.draft, 'Retained native surface draft'); assert.equal(coveredSource.owner, retainedOwner);
  const coveredKeys = [];
  await page.focus(`${knowledge} input[aria-label="Search nodes"]`);
  for (const command of ['Tab', 'Shift+Tab', 'Find']) {
    if (command === 'Tab') await page.keyboard.press('Tab');
    else if (command === 'Shift+Tab') { await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); }
    else await chord('f');
    await settlePaint();
    coveredKeys.push(await page.$eval(surface, (root, command) => ({ command,
      focusedOlderSurface: root.contains(document.activeElement), focusedCoreComposer: !!document.activeElement?.closest('[data-testid="composer"]'),
      focusedSessionFind: !!document.activeElement?.closest('[data-testid="session-find"]'),
      activeLabel: document.activeElement?.getAttribute('aria-label'), sessionFindCount: document.querySelectorAll('[data-testid="session-find"]').length }), command));
  }
  assert.ok(coveredKeys.every(sample => !sample.focusedOlderSurface && !sample.focusedCoreComposer && !sample.focusedSessionFind && sample.sessionFindCount === 0), 'Real Tab/Shift+Tab/Find must not address covered fields, thinking controls or native session Find');
  assert.deepEqual((await api(`/api/chats/${fixture.chatId}`)).payload.settings, sessionSettingsBeforeCoveredKeys, 'Covered Shift+Tab must not change native thinking/model settings');
  assert.equal(await pickerNode.evaluate((node, selector) => node.isConnected && node === document.querySelector(selector), knowledge), true, 'Covered commands retain the same open picker');
  assert.equal(await retained.evaluate((node, owner) => node.isConnected && node.value === 'Retained native surface draft' && node.closest('[data-plugin-session-surface]').getAttribute('data-interaction-layer') === owner, retainedOwner), true);
  evidence.coveredSurfaceCommands = { source: coveredSource, keys: coveredKeys }; await pickerNode.dispose();
  await closeKnowledge();
  assert.equal(await page.$eval(surface, node => !node.closest('[inert]')), true, 'Closing newer main-pane picker resumes its surface owner');
  await page.locator(button("surface-nested", surface)).click(); await page.waitForSelector(nested, { visible: true });
  assert.equal(await retained.evaluate(node => node.isConnected && node.value === "Retained native surface draft" && !!node.closest("[inert]")), true);
  await page.locator(button("menu-down", nested)).click(); await page.waitForSelector('[data-testid="plugin-menu"]', { visible: true });
  assert.equal(await paintedTop('[data-testid="plugin-menu"]'), true, 'Surface-owned menu paints above the newer native frame');
  const menuOwner = await page.$eval('[data-testid="plugin-menu"]', (menu, nested) => ({ portal: menu.closest('[data-interaction-popup-host]')?.getAttribute('data-interaction-popup-host'), owner: document.querySelector(nested).closest('[data-plugin-session-surface]').getAttribute('data-interaction-layer') }), nested);
  assert.equal(menuOwner.portal, menuOwner.owner, 'Menu must use its current native surface owner, not a stale prior picker/page view');
  evidence.surfaceMenuOwner = menuOwner;
  await page.keyboard.press("Escape"); await page.waitForSelector('[data-testid="plugin-menu"]', { hidden: true }); assert.equal(await page.$$eval('[data-plugin-session-surface]', nodes => nodes.length), 2);
  await page.locator(button("dialog-ordinary", nested)).click(); await page.waitForSelector('[data-showcase="dialog-ordinary"]', { visible: true });
  await page.focus('[role="dialog"][aria-label="Ordinary dialog example"] button[aria-label="Close dialog"]');
  await page.keyboard.press("Escape"); await page.waitForSelector('[data-showcase="dialog-ordinary"]', { hidden: true });
  await chord(","); await page.waitForSelector('[data-testid="settings-dialog"]', { visible: true });
  assert.equal(await page.$eval('[data-testid="settings-dialog"]', node => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); }), true);
  await page.keyboard.press("Escape"); await page.waitForSelector('[data-testid="settings-dialog"]', { hidden: true }); assert.equal(await page.$$eval('[data-plugin-session-surface]', nodes => nodes.length), 2);
  await screenshot("native-session-surface-stack", { fullPage: false });
  await page.keyboard.press("Escape"); await page.waitForSelector(nested, { hidden: true });
  assert.equal(await retained.evaluate(node => node.isConnected && node.value === "Retained native surface draft" && !node.closest("[inert]")), true);
  await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, button("surface-nested", surface));
  await page.locator('[data-plugin-session-surface] button[aria-label="Close"]').click(); await page.waitForSelector(surface, { hidden: true }); await retained.dispose();
  await openGallery(); await waitState("composer", { draft: "", sends: 0 });
  evidence.assertions.push("Real native session toolbar supplies opaque target. Painted surface frame exactly fills body, excludes header/sidebar and inerts native composer. Nested surface/menu/dialog/Settings stack retains parent DOM/value, closes only top Escape and restores trigger focus; host X closes parent; navigation remounts clean gallery.");

  evidence.stage = "disable cleanup";
  await click("dialog-nested"); await page.waitForSelector(parentDialog, { visible: true });
  await api("/api/plugins/ui-showcase", "PUT", { enabled: false });
  await page.waitForSelector('[data-showcase]', { hidden: true });
  await page.waitForSelector('[data-testid="plugin-menu"]', { hidden: true });
  assert.equal((await api("/api/plugins")).payload.plugins.find(value => value.id === "ui-showcase").status, "disabled");
  // Disabled view renders a Back-to-home Link; it does not redirect.
  // Assert that native fallback before moving to the re-enabled session proof.
  await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('This plugin is disabled.'));
  await api("/api/plugins/ui-showcase", "PUT", { enabled: true });
  await page.goto(base + `/chat/${fixture.chatId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('main [data-testid="composer"] [contenteditable="true"]', { visible: true });
  await openSurface();
  await page.locator(button("surface-nested", surface)).click(); await page.waitForSelector(nested, { visible: true });
  await page.locator(button("menu-down", nested)).click(); await page.waitForSelector('[data-testid="plugin-menu"]', { visible: true });
  await api("/api/plugins/ui-showcase", "PUT", { enabled: false });
  await page.waitForSelector('[data-showcase]', { hidden: true });
  await page.waitForSelector('[data-plugin-session-surface]', { hidden: true });
  await page.waitForSelector('[data-testid="plugin-menu"]', { hidden: true });
  assert.equal((await api("/api/plugins")).payload.plugins.find(value => value.id === "ui-showcase").status, "disabled");
  evidence.assertions.push("Plugin disable disposes gallery plus open dialog, and after re-enable also disposes parent/nested native surfaces plus an open menu, with no orphan showcase DOM. Global/default settings and synthetic knowledge remain unchanged; no off-origin requests, model generation or mic recording.");
});
