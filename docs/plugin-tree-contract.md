# 共享树形展示—插件 API v1

当前的 API v1 契约。确切的公开类型位于 `src/core/plugin-tree.ts`，`mountTree` 位于 `src/core/plugin-ui.ts`。请使用与目标应用相匹配的文档和仅类型的 SDK 声明，而不是私有的运行时导入。

## 边界

现有的原生推理链（Chains）界面使用了一个可维护的共享展示基础层，但没有移动其控制器或业务逻辑。原生推理链的外观、导航、选择、排序和来源操作保持不变。插件适配器是 `components/plugin-tree.tsx`；它暴露的是相同的原生展示，而不是原生数据或推理链控制器。

```ts
ctx.ui.mountTree(container, tree, { signal }): PluginWidgetHandle<PluginTreeProps>
```

`tree` 是一个通用的配置对象。`PluginTreeProps` 指的是 TypeScript 属性；它不是原生推理链中显示命题数量的 **Props** 列。该组件不会打开任何东西：知识选择、对话框和会话界面仍是各自独立的 API。

调用方负责层级/数据、搜索、排序、操作、领域内的重命名/移动规则、选择策略、存储、滚动容器、加载状态和空状态 UI。这不是文件管理器、卡组/卡片库领域 API，也不是新的声明式 UI 框架。不添加列宽调整或表头吸顶系统。这里不迁移闪卡或任何其他产品插件。

## 受控配置

- `PluginTreeProps`：必需的无障碍 `label` 和 `rows`；可选的主列 `header` 和尾部 `columns`。`label` 只是无障碍名称，绝不会自动成为可见标题。主内容填满剩余宽度。
- `PluginTreeRow`：`key`、主 `content`，以及可选的 `cells`、`children`、`selection` 和 `disclosure`。每一行都有一个 **全局唯一的出现键**，包括位于已折叠祖先之下的行。只要唯一，任何字符串（包括 `""`）都可以。该键标识的是这一次显示出来的出现，与它所代表的实体无关：没有 `itemId` 字段，重复的实体出现之间也不存在推断出的关联。
- `selection`：`{ label, checked, indeterminate?, disabled?, onChange(checked) }`。调用方独立控制每个复选框。不提供父/子选择级联，也不提供推导出的半选状态。
- `disclosure`：`{ label, expanded, onChange(expanded) }`。展开状态是受控的；通过 `update` 发布已接受的状态。没有 disclosure 的子项始终可见。折叠的 disclosure 会卸载后代内容并运行清理；重新展开会重新挂载。需要保留的数据/草稿应持久化在插件状态中，而不是已挂载的 DOM 里。
- `PluginTreeColumn`：`{ key, header, width, align? }`；行的 `cells` 以所配置列的键为键。对齐方式默认为 `"left"`，也可以是 `"right"`。数字宽度以像素为单位，必须是有限的非负数（**0 是有效值**）；非空白字符串则按 CSS 宽度语义处理。宽度不是一项列宽调整或持久化服务。

主行/表头内容和尾部单元格/表头内容接受 `PluginTreeContent`：`string | PluginUiContent`。后者是现有的 HTMLElement 或受 signal 作用域约束的挂载函数，可带可选的同步/异步清理。富内容占据的是 **固定的原生行/表头/单元格外壳内部** 的插槽；它不能替换行的标记结构、复选框、disclosure 控件或它们的对齐方式。操作可以是插件自有的内容；宿主不会根据数据推断行操作。

## 布局与交互

如果配置中任何一行（包括已折叠的后代）都没有 `selection`，就会移除复选框槽位。只要有任何选择，就会为 **所有** 行保留该槽位。没有分支或 disclosure 的普通扁平列表没有 disclosure 槽位；层级结构会保留对齐的 disclosure 空间。原生参考线位置为 **无选择时 19px** 或 **有选择时 37px**，再加上 **每层深度 36px**。

原生排版默认使用 `font-ui`：主标签为 `text-sm`（**12.5px**），字重 **500**；元数据和表头为 `text-xs`（**11px**），字重 **400**。承载宽度的表头单元格和正文单元格使用相同的字体度量，CSS 的 `em`/`ch` 宽度也是如此；但这并不保证在宽度受限时位置对齐。富内容可以覆盖自身的样式。原生细分隔线 **只出现在顶层分组之间**：嵌套行没有分隔线，最后一个分组之后也没有。内部根选择器是实现细节，不是样式 API。

**在 v1 中，列的适配、可用宽度和滚动由调用方负责。** 如果容器容纳不下所配置的尾部列宽加上最大层级缩进和控件/前缀空间，布局就可能溢出，即使声明的宽度得到保留，表头/正文的列位置也可能错开。相同的字体度量并不能消除这一限制。请提供足够的宽度，或者在调用方自有的水平滚动容器中设置内部最小宽度，或者选择更少/更窄的列。所需的宽度预算取决于你的层级、控件、列和主内容；宿主不提供最小宽度计算、裁剪策略或响应式布局引擎。原生行为保持不变。

该组件复用 **现有的原生推理链方向键行导航**，而不是原生 Tab 焦点：上/下方向键在同级之间移动；右方向键在受控更新后打开一个已关闭的分支并进入其第一个子项，或进入已打开分支的第一个子项。左方向键遵循原生的父项/折叠父项规则（可展开的根项会折叠自身）。空格键只在启用时切换当前行可选的、由宿主提供的复选框。插件的文本输入框、contenteditable 内容以及已被处理的按键保留它们自己的交互。

一个很薄的根局部适配器使用私有的纯函数内核 `components/tree-navigation.ts`，它是从 `chain-navigation.ts` 中机械提取出来的；原生导出是它的别名，而原生 hook、元数据和事件策略保持不变。嵌套的组件根各自独立导航。这不会添加自动聚焦、查找/搜索处理、全局处理器、公开的键盘控制器 API 或新的 props。**应用范围的 Tab 策略在所有上下文中都保持不变**：不引入任何 Tab 例外，也不承诺原生 Tab 浏览器焦点。

## 生命周期与更新

适用常规的组件契约：作为末位参数的 `{ signal }`、浅层的 `update(partialTree)` 和幂等的 `dispose()`。修改 `rows`/`columns` 时请替换完整的数组；仅靠回调不会更新受控值。组件 signal 中止、插件停用、行移除、折叠和内容替换都会清理受影响的挂载。设置 `selection.disabled` 会禁用该复选框；它 **不会** 卸载行内容。异步内容必须遵守其挂载 signal；延迟的清理遵循现有的 `PluginUiContent` 生命周期。

当内容需要保持挂载时，请在多次更新之间保持挂载函数的标识不变。每次更新都创建新函数会替换该内容并重新挂载；稳定的出现键并不能覆盖内容标识的变化。即使函数标识稳定，重新展开已折叠的内容仍会重新挂载。

## 示例：插件自有的文件夹和文件

在插件视图的 `mount(container, signal)` 内部，此示例使用任意的类文件数据，而不是宿主的文件系统服务。调用方保留展开状态、选择状态和一份草稿。外层容器演示了由调用方负责的水平滚动，以及一个仅作示意的 `32rem` 内部最小宽度；请为你自己的数据选择足够的预算，这不是宿主的固定要求。

```js
let expanded = true;
let checked = false;
let draft = "A plugin-owned note";
let treeHandle;

// Stable function identity; the draft survives descendant unmount/remount.
function noteContent(slot, mountSignal) {
  if (mountSignal.aborted) return;
  const field = document.createElement("input");
  field.setAttribute("aria-label", "Note draft");
  field.value = draft;
  const saveDraft = () => { draft = field.value; };
  field.addEventListener("input", saveDraft);
  slot.append(field);
  return () => {
    field.removeEventListener("input", saveDraft);
    field.remove();
  };
}

function rows() {
  return [{
    key: "folder-occurrence", content: "Notes", cells: { kind: "Folder" },
    disclosure: {
      label: "Expand Notes", expanded,
      onChange(value) {
        expanded = value;
        treeHandle.update({ rows: rows() });
      }
    },
    children: [{
      key: "note-occurrence", content: noteContent, cells: { kind: "File" },
      selection: {
        label: "Select note", checked,
        onChange(value) {
          checked = value;
          treeHandle.update({ rows: rows() });
        }
      }
    }]
  }];
}

const scroller = document.createElement("div");
scroller.style.overflowX = "auto";
const inner = document.createElement("div");
inner.style.minWidth = "32rem"; // Illustrative caller choice, not a host minimum.
scroller.append(inner);
container.append(scroller);

treeHandle = ctx.ui.mountTree(inner, {
  label: "Plugin notes", header: "Name",
  columns: [{ key: "kind", header: "Kind", width: 72, align: "right" }],
  rows: rows()
}, { signal });
return () => {
  treeHandle.dispose();
  scroller.remove();
};
```

<a id="testing"></a>
## 测试

测试受控控件/出现键、更新之间的内容保留、折叠/重新挂载、延迟清理、可编辑内容/嵌套组件的键盘隔离、原生推理链的回归，以及宽度足够时表头/正文的对齐。约束不足的布局仍由调用方负责，不属于对齐保证的范围。
