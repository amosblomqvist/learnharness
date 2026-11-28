# 构建 LearnHarness 插件

插件是**受信任的本地代码**，而不是沙箱化的扩展。后端模块运行在 LearnHarness 的 Node
服务器中，拥有文件系统/网络访问权限；前端运行在应用页面中。只安装你信任的代码。该 API
不会暴露服务商凭据，也不会放宽 Electron 渲染进程的隔离。

本指南描述的是与之匹配的源码/构建版本的 API v1。API v1 可以在不改变 API 编号的情况下增加能力。
请使用与目标应用匹配的文档/类型，并将 `minAppVersion` 设为确实提供了你所用全部能力的版本。
下载的技能中的 `bundle.json` 标明了生成它的应用版本、API 版本和 SDK 版本；
这些是各自独立的编号，不能互换当作兼容性保证。

## 文档导航

| 需求 | 阅读 |
| --- | --- |
| 第一个插件与安装 | [快速开始](#快速开始)，然后是[包布局](#包与安装) |
| 每个公开签名、属性及配套类型 | [完整 API 参考](plugin-api/README.md) |
| 真实项目与源码阅读路线 | [示例](plugin-examples.md) |
| 教学问题与评分 | [问题契约](plugin-question-contract.md) |
| 练习题目与处理 | [题目契约](plugin-problem-contract.md) |
| 提交拦截、图片与覆盖层 | [会话扩展](plugin-session-extension-contract.md) |
| 当前会话快照与草稿 | [视图上下文](plugin-view-context.md) |
| 受控树 | [树契约](plugin-tree-contract.md) |
| 模态框、菜单、焦点与 Escape 规则 | [交互契约](dialog-overlay-contract.md) |
| 宿主职责与实现边界 | [架构](plugin-architecture.md) |

API 参考由与可移植 SDK 相同的公开契约生成。它为每个公开类型和已声明成员建立索引，
包括重载以及被引用的本地数据/事件类型。指南解释行为与恢复方式；参考中的签名
说明确切的结构。两者都不需要导入应用私有的运行时模块。

<a id="quick-start"></a>
## 快速开始

主要的源码开发工作流是**克隆到应用的插件目录中并在那里构建**。
不需要克隆 LearnHarness 仓库。

1. 打开 **设置 → 社区插件**（Settings → Community plugins），复制插件目录路径。
2. 将插件的仓库克隆到 `<plugins-directory>/<plugin-id>`。文件夹
   名称必须与其清单中的 `id` 一致，它可能与仓库名称不同。
3. 按照项目说明安装依赖，然后在该文件夹中运行 `npm run build`。
   构建会直接写入它的 `dist/`；不需要额外的安装步骤。
4. 刷新列表并启用该插件。修改已加载的代码后需重启 LearnHarness；
   刷新只会发现包，而不会热重载 JavaScript。

对于提供了锁文件和构建脚本的项目：

```sh
git clone <repository-url> "<plugins-directory>/my-plugin"
cd "<plugins-directory>/my-plugin"
npm ci
npm run build
```

只构建你信任的代码：依赖安装和构建脚本都会执行本地代码。
LearnHarness 本身不会运行任何 npm 命令。构建必须保留同级的 `data/`。

对于新插件，下载并解压 **下载插件开发技能**（Download authoring skill），然后把整个
`learnharness-plugins/` 文件夹交给你的编程智能体，并让它阅读 `SKILL.md`。其中的 README
说明了智能体的设置方法。附带的 SDK 无需 LearnHarness 检出副本即可使用；插件的
构建工具/依赖需另行安装。

从 **Hello** 开始，它是最小的插件。然后按照[示例阅读路线](plugin-examples.md)
探索 **UI Showcase**、**Drawing Pad**、**Coding Questions**、**Flashcards** 和
**Rich Code Blocks**。该技能包含它们实际的源码项目，而不是平行的
示例实现。Managed Agent 和 Teaching Extension 是聚焦的示例方案，用于演示
较大项目没有那么直接展示的能力。

Hello 和这两个聚焦示例方案附带免构建的发行版，可以
[直接安装](#安装预构建的包)；它们导出的清单要求 `bundle.json` 中记录的
生成应用版本。官方源码参考清单保持不变。四个官方项目是使用保留 ID 的核心插件：
阅读它们的代码，而不是将其视为安装未经修改的社区副本的说明。UI Showcase 是一个社区
开发者展示库。使用模型的示例方案在被明确运行时可能产生费用。没有任何东西会被
自动安装；请保持技能完整，切勿把整个技能当作一个插件安装。

## 选择扩展点

| 目标 | API / 参考 |
| --- | --- |
| 自有页面和控件 | `registerView`、动作、`ctx.ui`（见下文） |
| 专属插件设置 | `registerSettings`（见下文） |
| 检查当前会话，包括未发送的输入 | 会话顶栏 `context.view`；[视图上下文](plugin-view-context.md) |
| 向现有智能体添加指令或工具 | `registerInstructions`、`registerTools`（见下文） |
| 自定义教学问题及编辑器 | `registerQuestionType` + `registerQuestionRenderer`；[问题契约](plugin-question-contract.md) |
| 自定义练习题目及编辑器 | `registerProblemType` + `registerProblemRenderer`；[题目契约](plugin-problem-contract.md) |
| 转换学习者输入或附加图片 | `registerSubmissionInterceptor`；[会话扩展](plugin-session-extension-contract.md) |
| 覆盖当前页面主体 | `ctx.ui.openSurface`；[覆盖层契约](plugin-session-extension-contract.md#8-公开覆盖层契约) |
| 渲染代码围栏或工具结果 | `registerCodeBlock`、`registerToolRenderer`（见下文） |
| 显示受控层级结构 | `ctx.ui.mountTree`；[树契约](plugin-tree-contract.md) |
| 转换上传的 PDF/文本文件 | 前端 `ctx.documents.toMarkdown`（见下文） |
| 读取已保存的学习记录 | 后端 `ctx.learning`（见下文） |
| 调用模型、运行对话或结果任务 | 后端 `ctx.inference`、`ctx.agents`、`ctx.workers`（见下文） |

各功能契约定义生命周期与验收规则；本指南是入口。
浏览[完整 API 参考](plugin-api/README.md)以获取确切签名和
交叉链接的类型。权威的公开契约位于 `src/core/plugins.ts`、`plugin-ui.ts`、`plugin-agents.ts`、
`plugin-workers.ts`、`plugin-questions.ts`、`plugin-problems.ts`、`plugin-submissions.ts`、
`plugin-view-context.ts` 和 `plugin-tree.ts`（均位于 `src/core/` 下）。请使用**仅类型**
导入，切勿在运行时导入宿主的私有模块。可移植的仅类型 SDK 由
`node scripts/build-plugin-types.mjs` 生成。仓库内的 TypeScript 插件使用
本地 `.sdk/` 和 `npm run sdk`；在检出副本之外，请在安装依赖之前把解压后技能中的
`types/` 复制到 `.sdk/`。例如，
在开发依赖中使用 `"learnharness-plugin-api": "file:./.sdk"`，并在 TypeScript 中使用
`import type { PluginFrontendContext } from "learnharness-plugin-api"`。
进行类型检查时需提供 SDK 包声明的 peer 依赖；不要在运行时导入它。
构建 SDK 需要检出副本；使用下载的 SDK 则不需要。Pi 原生类型
有意作为 API v1 的一部分，跟随应用锁定的 SDK 版本，而不是任意的 Pi 版本。

<a id="package-and-installation"></a>
## 包与安装

社区包使用以下可写的安装布局：

```text
<learning data>/plugins/my-plugin/
  package.json       # optional authoring configuration
  src/               # optional source; never a runtime fallback
  dist/              # required fixed runtime root
    manifest.json
    main.js          # optional browser ES module
    backend.cjs      # optional Node CommonJS module
    styles.css       # optional; requires a frontend entry
    assets/          # public distributable assets/modules
  data/              # persistent sibling; never distribute or serve it
```

清单包含 `apiVersion: 1`、与工作区文件夹一致的小写连字符 `id`、
`name`、数字形式 `x.y.z` 的 `version` 和 `minAppVersion`；可选字段有 `description`、
`author`、`main`、`backend` 和 `styles`。`main` 或 `backend` 至少需要提供一个。
可选的 `locales.zh.name` / `locales.zh.description` 在中文界面下替代 `name` / `description`。
前端代码可通过 `document.documentElement.lang`（`zh-CN` 或 `en`）、后端通过 `process.env.LH_LANG`（`zh` 或 `en`）得知界面语言。
入口文件名指向 `dist/` 根目录下带有所需扩展名的文件，而不是
指向源码或数据中的路径。格式错误/不兼容的包会被报告，且不会被执行。

- 直接构建到项目的 `dist/`，而不是 `dist/<id>/`。打包 JavaScript
  依赖；在 CommonJS 后端中把 Node 内置模块保留为外部依赖。宿主
  不会安装依赖，也不会重新构建原生模块。
- 分发构建好的 `dist/` **内容**，将其安装到 `<id>/dist/`，而不是 `<id>/`。
  免构建示例已经采用这种布局，可以整个文件夹复制。
- 更新代码时保留 `<id>/data/`。构建清理只能删除生成的
  `dist/`，绝不能删除工作区或数据。在删除/构建之前，拒绝符号链接形式的 `dist/`
  以及任何放错位置的 `dist/data/` 条目（包括符号链接）。
- 数据结构/迁移由插件负责；遇到你不理解的更新格式时，拒绝改写它。
  `data/agents/`、`data/tasks/` 和 `data/usage.jsonl` 保留给宿主服务使用。
- 新发现的插件默认处于禁用状态。禁用不会删除数据。
  仅有源码的项目和只在根目录放置清单的项目无法安装。不存在单独的
  开发注册、旧布局回退或代码热替换。

核心插件和社区插件使用相同的 API，但代码/数据位置相互独立。
应用以扁平的已构建包形式在应用的 `core-plugins/<id>/` 中内置 Flashcards、Coding Questions、Drawing Pad 和 Rich Code Blocks，
它们被直接加载，不会在用户数据中复制代码。
它们可写的设置/记录位于 `<learning data>/core-plugin-data/<id>/`。
代码始终使用 `ctx.directory`，可写记录始终使用 `ctx.dataDirectory`；不要
从其中一个推断另一个。核心插件随应用更新，并在
**设置 → 核心插件**（Settings → Core plugins）中管理；四个插件初始均为禁用状态，已有的明确选择在
更新后保留，禁用绝不会删除数据。它们的 ID（`flashcards`、`coding-questions`、
`drawing-pad`、`rich-code-blocks`）即使在核心包损坏/缺失时也保持保留。
发生冲突的社区文件夹会被跳过并给出诊断信息，且不会被修改。

仓库源码保留在 `plugins/` 中。`npm run plugins:build-core` 构建 `core-plugins.json` 中
所选的目录并暂存生成的包。UI Showcase 仍然是
源码/开发者示例，而不是随应用发布的核心包。该构建命令绝不会在学习数据目录中安装
或启用任何包。

<a id="install-a-prebuilt-package"></a>
### 安装预构建的包

复制/解压插件，使其构建文件位于
`<plugins-directory>/<plugin-id>/dist/manifest.json`，并与同级的打包文件/资源放在一起。
附带的免构建示例已经采用 `<plugin-id>/dist/` 布局：复制某个示例的
整个文件夹，刷新列表并启用它。这些示例不需要任何 Node/npm 环境。
不要额外嵌套一层 `dist/<plugin-id>/`。

更新现有插件时，只替换它的 `dist/`，并保留同级的 `data/`。
重启 LearnHarness 以加载已加载代码的更新。

<a id="develop-outside-the-plugins-directory"></a>
### 在插件目录之外开发

保持相同的项目布局并在本地构建。可以将完成的 `dist/` 复制到
`<plugins-directory>/<plugin-id>/dist/`，也可以使用可移植的本地安装器。

1. 将解压后开发技能中的 `tools/install-plugin-local.mjs` 复制到你的
   项目的 `scripts/install-plugin-local.mjs`。在 LearnHarness 检出副本中，同一个
   辅助脚本位于 `scripts/install-plugin-local.mjs`。
2. 将此脚本添加到插件的 `package.json` 中，与已有的 `build` 脚本并列：

   ```json
   {
     "scripts": {
       "install:local": "npm run build && node scripts/install-plugin-local.mjs"
     }
   }
   ```

3. 在插件项目中，传入设置中显示的目录：

   ```sh
   npm run install:local -- "<plugins-directory>"
   ```

该命令会先进行构建。如果构建失败，则不会执行安装。该辅助脚本只使用
Node 内置模块，会检查构建出的清单/入口文件，并按
清单中的插件 ID 安装。传入的插件目录必须已经存在。它不会
推断配置档案，也不会保存配置。刷新时，仍由宿主决定应用兼容性以及
保留 ID 的准入。

对于更新，辅助脚本会先暂存一个完整的替换版本，再把之前的 `dist/`
移到一旁；过时的资源会被删除而不是合并。如果替换失败，它会恢复
之前的包。如果回滚本身也失败，错误信息会给出所保留备份的路径。
同级的 `data/`、源文件和启用选择均不受影响。符号链接形式的根目录、
包条目或目标路径，以及放错位置的 `dist/data/` 都会被拒绝。不可分发的
`data/`、`node_modules/`、`.git/` 和凭据文件不应放在 `dist/` 中。

如果源码与已安装的 `dist/` 已经是同一个目录，辅助脚本会报告这是
原地构建，不进行复制。对于这种工作流，建议直接使用 `npm run build`。
之后刷新/启用新插件；对于已加载的代码，需重启 LearnHarness。
该命令不会自动启用插件或重启应用。

## 前端生命周期与导航

```js
export function activate(ctx) {
  ctx.registerView({
    id: "library",
    name: "My library",
    mount(container, signal) {
      const button = ctx.ui.mountButton(container, {
        label: "Plugin settings", onClick: () => ctx.app.openSettings()
      }, { signal });
      return () => button.dispose();
    }
  });
  ctx.registerAction({
    id: "open-library", name: "Open my library",
    run: () => ctx.app.openView("library")
  });
  ctx.placeAction({ id: "library-sidebar", actionId: "open-library", location: "sidebar" });
}
```

每个已启用的插件**在每个窗口中**激活一次。返回的清理函数和
`ctx.cleanup(fn)` 会在禁用时运行。在激活期间注册视图/动作/设置；
不要在模块顶层启动副作用，因为原生模块会保持缓存。
视图/动作 ID 由 1–128 个 ASCII 字母、数字、点、下划线或连字符组成，
以字母或数字开头。显示名称是普通文本。

视图只挂载功能主体。宿主负责其顶栏、标题、已放置的动作、
溢出菜单和设置齿轮。`mount(container, signal)` 可以异步返回清理函数；
离开/替换/禁用会中止它的 signal。把这个**每次挂载**的 signal 传给组件，
而不要只传更长的激活 signal。卸载 React 根节点并释放事件/定时器。
使用作用域内的 CSS/主题变量（`--foreground`、`--background`、`--border`）和安全的文本
插入方式；共享页面的 CSS 没有沙箱隔离。

视图主体在一个有边界的、全宽的宿主视口中滚动，该视口位于**顶栏下方**，
其滚动条紧贴主窗格的右边缘。长内容不得移动
文档、顶栏或侧边栏。插件仍然可以提供自己的有界
滚动容器；能够容纳的内容不会产生第二条宿主滚动条。页面主体
覆盖层是独立的同级浮层，而不是背景滚动视口的子元素。

`ctx.app` 暴露 `pathname()`、`openSession(id)`、`openHome()`、`openView(id)` 和
`openSettings()`；后两者以本插件为目标。它不暴露任何私有的 React 上下文
或图谱选择的内部实现。

### 动作

**先**注册动作，**再**放置它。一个动作具有 `id`、`name`、可选的受信任
SVG `icon`、可选的声明式 `shortcut`、可选的 `disabled` 布尔值/上下文谓词，以及 `run(context)`（同步或
异步）。宿主提供按钮/工具提示、忙碌/重复触发防护以及错误报告。
当插件状态改变了某个动态谓词时，使用 `ctx.refreshActions()`。

放置位拥有独立的 ID/注销句柄：`{ id, actionId, location }`。
`sidebar` 与核心动作区域共享位置；`graph` 使用图谱动作条。`top-bar`
需要明确指定 `sessions: ["teaching", "practice"]`（或其任一子集）和/或 `views`
（本插件的视图 ID）。仅注册不会创建任何导航界面元素。

| 上下文 `placement` / `surface` | 附加字段 |
| --- | --- |
| `top-bar` / `session` | `sessionId`、`kind`、不透明的 `surfaceTarget`、只读 `view` |
| `top-bar` / `plugin-view` | `pluginId`、`viewId` |
| `sidebar` / `sidebar` | 无 |
| `graph` / `graph` | 无 |
| `keyboard` / `session` | 相同的会话字段，包括一个新的只读 `view` |
| `keyboard` / `plugin-view` | `pluginId`、`viewId` |
| `keyboard` / `app` | 当前 `pathname`（其他应用页面） |

会话的 `context.view` 是一个新的、已分离/冻结的快照：完整的浏览器原生
`messages`、宿主投影的 `transcript`、元数据/状态、排队中的插话、保留的
输入框文本以及宿主选定的原生/自定义输入，包括显示出的选项顺序
和已发布的未发送草稿。在多次 await 之间，它始终绑定到其原始会话/出现实例。
读取操作绝不会揭示输入、刷新语音听写、保存、处理或提交。禁用
谓词接收相同的只读结构；每次点击都会重新捕获。在选择面向学习者的引用时，
请遵守所提供的揭示/可用性标志：完整历史是
可检查的，并没有被清理成仅包含当前已绘制的文字。参见[视图上下文契约](plugin-view-context.md)。

<a id="action-shortcuts"></a>
### 动作快捷键

让现有动作选择加入键盘设置和快捷键速查表：

```ts
ctx.registerAction({
  id: "open-board", name: "Open board",
  shortcut: {
    scope: { sessions: ["teaching", "practice"], views: ["board"] },
    defaultBinding: "mod+shift+d", // illustrative; omit to start unbound
  },
  run(context) {
    if (context.surface === "session") {
      // Keyboard and top-bar invocations both receive context.view.
    }
  },
});
```

`scope: "app"` 明确地让动作在所有页面中生效。否则需提供非空的
`sessions` 和/或 `views` 作用域；视图 ID 始终属于本插件。注册时会
捕获一个已分离/冻结的作用域/默认值。要更改它们，请先注销再重新注册；
`refreshActions()` 仍用于动态的启用状态，而不用于快捷键元数据的更改。
快捷键不需要放置按钮，没有 `shortcut` 的动作保持不变。
选择加入的现有动作必须接受 `placement: "keyboard"`，而不能假定是 `top-bar`。
全应用范围的动作在会话/插件视图页面上仍会收到实际的会话/插件视图上下文。

绑定使用现有的规范 `mod`、`alt`、`shift` 按键顺序：`mod+shift+d`、
`alt+x`、`f8` 等。`mod` 接受 Ctrl 或 Cmd。只支持单个 Mod/Alt 组合键以及功能
键 F1–F24。不支持 Escape/Tab/Enter 组合、单独的输入/导航键、
按键序列以及系统级全局热键。现有的输入区域保护机制仍然适用；
叶子编辑器拥有优先拒绝权。按键重复、已处理的事件和输入法组合输入都不会触发
插件动作。触发时使用现有的、具备禁用/忙碌/错误处理的动作执行器。

全应用范围指的是跨页面生效，而不是穿透阻断性界面。对话框、菜单、原生展开的
查看器以及其他插件的前台覆盖层会阻断快捷键。动作在其所属插件自己的页面主体覆盖层之上
仍然有效，因此可以用切换操作关闭该覆盖层。作用域
仍然指底层的活动页面。导航/保留绝不会调用旧
页面的读取器；会话快照在动作运行前就已分离，并在多次 await 之间
保持不可变。同一次物理按键不会穿透到被该按键关闭的前台之下。

设置会按插件名称列出已注册的快捷键，包括未绑定/存在冲突的
条目。“重新绑定”（Rebind）分配一个组合键；“清除”（Clear）保存为未绑定；“重置”（Reset）恢复可选的
插件默认值。覆盖设置共享 `lh:keymap`，键为 `plugin:<pluginId>:<actionId>`，并且
在禁用/重新启用或暂时缺失后依然保留。“全部重置”（Reset all）也会移除这些覆盖设置。
只有已启用/处于活动状态的注册项参与分发/冲突判定。

核心的实际生效绑定始终优先。作用域重叠、相互竞争的插件
默认值都保持不生效，不存在按加载顺序决出的胜者。明确的插件分配优先于
插件默认值；设置会拒绝与核心冲突以及与其他明确的
插件分配冲突的绑定，且不改变已保存的绑定。冲突依据声明的作用域重叠判定，
而不是依据暂时的禁用/忙碌/焦点状态。作用域不重叠时可以共用同一个组合键。如果
在作用域变更或手动编辑存储后，已保存的分配发生冲突，受影响的
绑定会以失效关闭的方式处理，设置中会解释该冲突。可点击的动作仍然有效。

<a id="controlled-host-ui"></a>
### 受控的宿主界面

全部 15 个 `ctx.ui` 方法都以 `{ signal }` 选项作为最后一个参数，并返回一个句柄，
它带有浅层的 `update(partialProps)` 和幂等的 `dispose()`。更新嵌套 props 时
需整体替换。中止/禁用插件会销毁相关的挂载/浮层。
值和持久化由插件负责；通过 `update` 把已接受的值回传。

| 方法 | 主要 props |
| --- | --- |
| `mountModelPicker` | `value: {provider,id} \| undefined`、`onChange`、可选 `disabled` |
| `mountThinkingPicker` | `model`、`value: ThinkingLevel \| undefined`、`onChange`、可选 `disabled` |
| `mountKnowledgePicker` | `value: readonly string[]`、`onChange`、可选 `disabled` |
| `mountComposer` | `value`、`onChange`、`onSend`；可选 `busy`、`onStop`、`canSend`、`placeholder`、`autoFocus` |
| `mountDictation` | `onTranscript`、可选 `disabled`；额外的句柄方法 `toggle`、`finish`、`cancel` |
| `mountStandardComposer` | `{composer,model,thinking,dictation}`，使用各自独立的控件 props |
| `mountButton` | `label`、`onClick`；可选 `icon`、`iconOnly`、`disabled`、`variant`、`colors`、`size`、`title` |
| `mountBadge` | `text`、可选 `color` |
| `mountSettingsRows` | `{rows}`，如下文所述 |
| `mountWorkerResult` | `label`、终态 `status`、`text`；可选 `content`、`presentation` |
| `mountMarkdown` | `text`（完整的静态 Markdown） |
| `mountTree` | 无障碍 `label`、受控 `rows`；可选 `header`、尾部 `columns` |
| `openMenu` | `items: [{key,label,onSelect,disabled?}]`；可选 `label`、`preferredSide`、`onClose` |
| `openDialog` | 无障碍 `title`、`content`、可选 `onClose` |
| `openSurface` | 无障碍 `title`、`content`；可选 `background`、`onClose`；可选的明确原生视图目标 |

挂载方法在 props 之前接收一个容器；`openMenu` 接收一个锚点。完整签名请参见类型
定义。回调可以是异步的；错误会被展示出来，而不会被算作成功。

同一个界面所有者以完全相同的锚点元素再次调用 `openMenu` 时，
会关闭现有菜单，而不是再叠加一个，即使该菜单尚未渲染也是如此。
现有菜单最新的 `onClose` 只运行一次；这次关闭调用返回一个无效
句柄，并且不会使用它传入的 props 或回调。其他界面所有者和锚点
保持相互独立。外部点击（包括点击其他按钮）、菜单操作和 Escape
沿用各自现有的关闭规则；只有 Escape 会把焦点恢复到锚点。显式的
句柄销毁以及调用方/插件/覆盖层的失效仍属于销毁，不会触发 `onClose`。

**输入控件。** 模型/推理强度选择器使用宿主的目录，不会更改核心
默认值，也不会选择回退模型。它们紧凑的排版是自包含的。
独立的输入框只是一个裸输入区域；标准预设只给文本输入区域加框，
控件位于其下方。它不包括用量指示、练习控件、附件以及默认的
文件/拖放行为。预设会在发送前完成语音听写；独立控件
必须自行协调这一点。

每个窗口只有一个录音所有者。相互竞争的启动会报告
`语音听写正在其他位置使用`。语音只会送到所提供的 `onTranscript`，而不会送到
隐藏的原生输入框。获得焦点的控件拥有与之匹配的快捷键；一次 Escape 不得
同时取消另一层的录音。`finish()` 会等待送达；`cancel()` 则取消。

**按钮。** `icon` 是受信任的 SVG 标记，而不是净化器/DOM/自定义渲染器插槽。
它位于必需的标签之前。`iconOnly: true` 会隐藏文本，并将 `label` 用作
无障碍名称；图标和标签都必须非空。`size` 只控制几何尺寸；
`title` 不会自动显示。无效的实时更新会被原子性地拒绝；移除
图标时还需要同时清除 `iconOnly`。

`variant: "custom"` 允许自定义颜色，但不覆盖几何尺寸/激活行为。可选的
`colors` 插槽包括常态的 `background`、`text`、`border`；具有相同插槽的 `hover`、`active`、`disabled`
对象；以及具有这些插槽外加 `ring` 的 `focusVisible`。
覆盖按属性逐级层叠：disabled > active > focus-visible > hover > normal。
常态回退值是原生主色，并保留一条透明的 1px 边框。
原生焦点环的几何尺寸、指针阻断以及禁用时 50% 的不透明度保持不变。

颜色必须是非空且浏览器支持的 CSS 颜色（允许使用变量/表达式）。
未知的插槽/结构/语法会被原子性地拒绝；变量解析/对比度仍是
插件的责任。颜色在所有变体上都会被校验，但只在 `custom` 上生效。
设置 `colors: undefined` 可恢复回退值；更新 `colors` 会替换整个调色板。
不存在任意 CSS、几何尺寸或键盘方面的覆盖。

**徽标。** `text` 是纯文本，而不是评分枚举或 Markdown。可选的 `color` 会设置
文本颜色以及 `color-mix(in oklab, color 15%, transparent)` 背景；省略时为中性样式。
无效的类型/颜色语法（包括 CSS 全局关键字）会被原子性地拒绝。它不隐含任何评分、
持久化、点击行为或实时播报。

**Markdown。** `mountMarkdown` 使用宿主实际共享的渲染管线来处理数学公式、高亮
代码、表格、提示块、Mermaid、图片和排版，但只使用内置功能：已注册的
插件代码围栏渲染器不会运行。它省略了辅助的复制/下载/重试/展开/缩放/
折叠控件。链接保留原生的新标签页行为，并带有 `noopener noreferrer`；
无效的 Mermaid 会直接显示其错误/源码。不要为了获得 Markdown 样式而伪造 worker 结果，
也不要导入私有渲染器。

**树。** `mountTree` 是受控的展示组件，而不是文件/卡组控制器。层级结构、
选择、操作、存储和滚动容器都由你负责。使用全局唯一的行
出现实例键、稳定的内容挂载标识以及足够的宽度预算；如果约束不足，列
加上缩进/控件可能会溢出并发生错位。折叠会卸载
后代内容，因此请把草稿保存在插件状态中。有关行/单元格插槽、方向键/空格键行为及示例，
请参见[树契约](plugin-tree-contract.md)。

**知识选择。** `mountKnowledgePicker` 复用原生的“选择节点”/计数/“清除”
气泡和推理链选择器。选择会立即变更；用
`update({value: ids})` 反映 `onChange(ids)`。“完成”/X/Escape 关闭时不会丢弃受控的选择。
宿主会捕获来源：页面/覆盖层来源会打开一个主窗格视图，而对话框/设置
来源会打开一个全视口模态框，其父级仍被绘制但处于不可交互状态。来源/组件的
生命周期、焦点恢复以及防止过期加载的保护都由宿主负责，而不是插件 props。
同一时间只有一个选择器处于活动状态。现有的、由用户发起的来源重命名/文件夹/拖动操作
仍然可用；管理用的“删除”则不可用。这不是后端的图谱写入 API。

**对话框与覆盖层。** `content` 是一个 HTMLElement，或是一个以 signal 为作用域、带有同步/
异步清理函数的挂载。两者都要求提供无障碍标题，但不会渲染宿主标题行；可见的
标题/操作由插件负责。一个低调的 X 按钮浮在滚动内容之上。覆盖层只覆盖
页面主体，而不覆盖顶栏/侧边栏，并且可以层叠，同时保持被覆盖的内容处于挂载状态。
使用不带目标的 `openSurface(props, {signal})` 一次性捕获当前边界，或者
传入确切的原生 `surfaceTarget`。离开页面会使其失效；切勿重建或
持久化目标。`background` 为 `dimmed`（默认的着色/模糊）或 `opaque`。

覆盖层可以用 `data-plugin-initial-focus` 标记一个同步挂载的、可见的可聚焦区域。
已有的合格焦点优先，然后是该标记，
再然后是输入字段/标题/框架。不承诺异步自动聚焦重试或更新时聚焦。
共享的模态框/菜单/Escape/焦点归属遵循[交互契约](dialog-overlay-contract.md)；
Tab/Shift+Tab 不会变成浏览器的焦点导航。有关生命周期、层叠、关闭和焦点返回规则，
请参见[覆盖层契约](plugin-session-extension-contract.md#8-公开覆盖层契约)。

### 专属设置

每个已启用的插件都有一个设置页面，包括仅有后端/没有设置项的插件。
设置 → 核心插件 / 社区插件 用于管理包；`ctx.app.openSettings()` 和视图齿轮会打开
本插件的页面。如果没有注册，它会显示 `暂无可用设置。`

`registerSettings({rows})` 返回一个支持 update/dispose 的组件句柄。或者，
`registerSettings({mount(container, signal) {...}})` 返回一个注销函数；
自定义挂载会延迟运行，并且自身可以使用 `mountSettingsRows`。

行具有唯一的非空 `key`、`label`、受控的 `value`、`onChange`；可选的
`description`、`disabled`、同步的 `validate(value): string | undefined`。类型：
`toggle`（布尔值）、`text`（字符串）、`dropdown`（带有 `{value,label}` 选项的字符串）、
`number`/`slider`（有限数值，带可选的 `min`、`max`、`step`）。无效的结构定义
会被拒绝；校验/范围失败会在行内显示，且不会调用持久化。真正
处于等待状态的 Promise 会禁用其所在行；同步的滑块变更不会打断拖动。
抛出异常/被拒绝的保存会显示错误。后端输入也要校验。

宿主不会加载/保存插件设置。只有在持久化成功后，才通过句柄发布已接受的行；
修改结构定义并不会创建响应式存储。

## 上传的文档

前端 `ctx.documents.toMarkdown(file, {signal}?)` 接收一个浏览器 `File`，并解析为
`{name, markdown, notices}`。激活取消是自动的；可选的调用方
signal 会附加一个更短的生命周期。失败时以 `Error` 拒绝；调用方取消
会保留 `AbortSignal.reason`。不存在后端文档成员、公开的错误码
DTO、路径/URL/令牌输入或文件选择器 API。请使用原生输入控件和这个辅助函数，而不是
`ctx.call`（它只支持 JSON）或私有的 multipart 路由。

- `%PDF-` 签名**或** `.pdf` 后缀会选用原生的确定性 PDF 引擎
  以及页面标记。无效的 PDF 不会回退为文本处理。混合文档中的纯图片页面会被
  跳过并给出提示；全是图片的 PDF 会被拒绝，且与空白 PDF 区分报告。不做 OCR。
- 其他所有内容都按严格的 UTF-8 处理，与扩展名/MIME 无关。二进制内容、空输入
  以及除 Tab/LF/CR 之外的控制字符（其他 C0、DEL 和 C1）会被拒绝。HTML/DOCX
  不会被转换为语义化的 Markdown。
- 上限：**25 MiB 文件**、**26 MiB 实际 multipart 请求体**、**1,000 个 PDF 页面**（在
  打开后检查）、**2 MiB 最终 UTF-8 Markdown**（包括标记）。超出时拒绝，绝不截断。
- 所有插件之间**同一时间只进行一个转换**；相互竞争的请求会立即以忙碌状态失败，没有
  队列。准入发生在缓冲之前，并持续到工作/销毁结算完成为止，
  包括取消之后。

取消是协作式的，而不是对截止时间/CPU/峰值内存/进程隔离的保证。
PDF 的伪 worker 解析可能会同步执行。转换不会进行任何持久化、
模型请求或学习数据更改；插件之后可以自行保存返回的文本。

<a id="backend-and-data"></a>
## 后端与数据

CommonJS 后端导出 `activate(ctx)`。每个服务器只激活一次；返回清理函数，
或通过 `ctx.cleanup` 注册它。宿主资源会遵从 `ctx.signal`；自定义任务必须
配合，并在 await 之后、产生副作用之前重新检查取消状态。不存在
每个插件独立的进程，也不会强制终止不配合的代码。

使用 `ctx.handle(name, handler)` 注册兼容 JSON 的操作，并在
前端通过 `await ctx.call(name, input)` 调用它们。它只会路由到该插件，
而不会路由到任意 HTTP 端点。请校验输入、暴露真实的错误，并对
`ctx.dataDirectory` 下由插件拥有的重要状态使用原子写入。

`ctx.learning` 是只读的：

| 成员 | 含义 |
| --- | --- |
| `directory` | 学习数据路径，而不是凭据路径 |
| `listSessions()`、`getSession(id)` | 摘要以及完整的原生记录 |
| `graph()` | 当前的图谱投影 |
| `readGraphFile(name)` | 由宿主解释的账本、来源、位置、格式/渲染元数据；来源是一个记录数组 |

要获取学习者的答案/思考/错误，请读取对话记录：图谱是从
老师的讲解文字中提取的，而不是完整的学习者回应记录。跨文件读取不具备
事务性。把派生出的功能数据写入插件状态，绝不要写入核心学习文件。

## 现有智能体与内容渲染器

`registerInstructions({agents, text})` 和 `registerTools({agents, create(context)})`
是增量式的贡献，目标为 `prober`、`teacher` 和/或 `practice`。它们不会
替换宿主提示词、模型设置或内置工具。每个匹配的回合都会获得一份
全新的原生 Pi 装载配置，带有冻结的 `{chatId, agent}`；宿主会保存调用/结果。
指令文本会被合入系统提示词，而不是成为单独的对话记录消息。

使用有辨识度的原生工具名称：1–64 个对各服务商安全的字母/数字/下划线/连字符，
以字母或下划线开头。核心名称即使在禁用时也保持保留。
按插件 ID 排序的准入绝不会覆盖冲突项；定义/工厂错误会使
该包在该回合的全部贡献被省略，并报告一条包警告，同时
保留相互独立的视图/后端可用。之后成功时会清除该警告。原生
schema 编译并不保证每个服务商都会接受该 schema。

注销会影响之后的回合；禁用会中止协作式的执行，并隔离
已捕获的工具/结果，而不会改写正在运行的提示词。在产生副作用之前
遵从 signal；外部效果无法撤销。

前端 `registerCodeBlock({language, mount})` 接收源码/元信息/未完成状态；
`registerToolRenderer({toolName, mount})` 接收原生的输入/状态/详情作为 `output`，
以及可选的结果内容，在之后的 worker 卡片上还会接收 `background`。挂载到所提供的
HTMLElement 中并返回清理函数；替换/注销/禁用会中止它的 signal。
支持异步清理。出错/缺少渲染器时会回退为可读的源码/结果。

代码围栏钩子参与共享的可扩展 Markdown，但不参与 `mountMarkdown`。
内置的 Mermaid/专用/隐藏工具声明保持保留；冲突会报告错误。
生产者身份只是元数据，而不是阻止跨插件展示工具的沙箱。
使用安全文本/受信任的资源，绝不使用未经净化的模型 HTML。渲染器不会创建
待处理的学习者输入：如需此功能，请使用专门的问题/题目 API。

## 教学问题、练习题目与学习者提交

这些扩展点共享原生的宿主生命周期；它们不是通用的表单 API。

- **教学：** 使用 `registerQuestionType` 注册 schema 以及摸底/教学的出题工具；
  通过 `registerQuestionRenderer` 注册以所有者为作用域的 `mountQuestion`、`mountAnswerEditor`、可选的 `mountAnswered`。
  身份、揭示、思考、
  校验、接受以及老师的后续讲解都由宿主负责。可选的 `gradeAnswer` 在
  校验之后、保存之前运行；有限 JSON 结果/错误会被持久化，并由
  插件渲染，而不会被推断为宿主判定的正确性。[问题契约](plugin-question-contract.md)。
- **练习：** 为原生的“题干 → 插件编辑器 → 你的思考停靠区”注册
  `registerProblemType` 和 `registerProblemRenderer`。每次提交都遵循
  校验 → 可选的 `processSubmission` → 保存 → 继续。处理过程提供
  观察结果；只有模型现有的 `conclude` 才会评估/结束该题目。
  原生/插件出题共享同一个活动题目闸门。[题目契约](plugin-problem-contract.md)。
- **输入准备：** `registerSubmissionInterceptor` 在每次尝试时捕获有序的钩子集合，
  可以转换学习者字段/附加原生图片，并在失败时以关闭方式处理，同时
  保留草稿。`hasPendingInput` 是同步且无副作用的；
  `refreshSubmissions()` 会更新就绪状态。只能通过
  已确认的 `onAccepted` 清除已捕获的插件素材，而不能在模型重试、关闭或确认丢失时清除。
  处于就绪状态的自定义编辑器值仍然是必需的。[会话扩展契约](plugin-session-extension-contract.md)。

不要根据原始模型工具名称或私有 DOM 推断权限，不要从已保存的历史中重建被打乱的
选项，不要伪造原生答案封装，也不要对
历史展示重新运行处理。确切的出现实例/已保存契约以及可用性闸门才是关键。

## 推理与持久化工作

### 原始模型调用

`ctx.inference.catalog()` 返回最近一次已知的宿主目录；请明确选择一个可用模型
（或明确使用已配置的槽位）。不提供静默刷新、未设置模型时的回退
或 API 密钥回退。`stream(request)` 返回原生事件；
`complete(request)` 返回一条原生助手消息，包括错误/中止状态。
请检查 `stopReason`，而不只是检查文本。

请求接收 `model`（包括推理强度）、原生 `context`、明确的
`purpose: "user" | "background"`、可选的、在允许列表内的生成/推理/重试
`options`，以及 signal。凭据/传输由宿主负责，并应用现有的
订阅同意、配额和取消规则。`purpose` 必须反映发起方式，
而不是视图是否处于打开状态；不要把自动执行的工作归类为用户输入来规避同意。
自定义 fetch/env/headers/延迟的远程工作都不是 API 选项。用量会追加到
插件的 `data/usage.jsonl`，而不是核心聊天记录中。

<a id="managed-conversational-agents"></a>
### 托管的对话式智能体

`ctx.agents.register(definition)` 定义指令、模型和原生工具；
`create(definitionId)` 创建一个对话；`send(sessionId, text, {requestId,purpose})`
添加输入。在每次激活之间持久化/重建兼容的定义：已保存的处理器
并不是 JavaScript，缺失的定义属于错误，而不是可以重新解释历史的许可。

`kind: "input"` 工具没有 `execute`；它会持久化外部输入。请自行渲染
`snapshot.pending`，并通过你的后端调用 `answer(sessionId, toolCallId, answer, options)`。
用相同的请求 ID 重试同一操作；新的 ID 意味着新的
操作。所有必需的输入都需要有结果才能继续。无效的答案不会被
保存；`formatResult` 可以塑造面向模型的内容。普通的服务器工具可以使用
`endRun: true` 在成功后暂停；之后的文本并不表示缺少工具结果。

`get`、`list`、`subscribe` 暴露状态/当前的部分结果。`agents-changed` 通知
和前端 `onResync` 会触发合并后的重新读取；不要轮询隐藏的视图。
取消订阅只会解除观察。导航/重新加载不会停止执行；
`abort` 以协作方式取消，`run` 会恢复可运行的输入，而不会代写“Continue”。
重启会恢复等待中的输入，并中断正在进行的工作。对于外部工具效果，不提供自动重放或
恰好一次的承诺。参见 `examples/plugins/managed-agent`。

<a id="result-oriented-workers-and-background-tools"></a>
### 面向结果的 worker 与后台工具

`ctx.workers` 运行只有一个经过校验的结果的任务，而不是需要人工输入的对话。
注册指令、`resultSchema`、可选且无副作用的 `validateResult` 以及
原生工具。`start(workerId, {requestId,input,prompt,model,purpose,...})`
会同步地持久化接受状态并返回一个快照，**而不是完成结果**。
`options` 使用推理的允许列表；`timeoutMs` 是包括准入等待在内的挂钟生命周期，
与每个请求的 `options.timeoutMs` 不同。模型/purpose 必须
明确指定。可选的 `maxTurns` 限制助手回合数，包括纠正回合；
省略它意味着没有回合数限制。明确的限制必须是正的安全
整数，并且会一直被强制执行。完全相同的请求 ID/请求会返回原来的
任务，而冲突的复用会报错。如需新的尝试，请使用新的 ID 重试。

宿主的 `submit_result({result})` 会校验 schema/细化规则，并在同一原生上下文中提供纠正
反馈。第一个被持久地接受的有效 JSON 胜出，包括
假值。没有结果的退出/耗尽/失败都不算成功。`wait(id)` 会解析为
终态结果；取消它的 signal 只会停止该等待者。`get`、`list`、快照优先的
`subscribe` 暴露已提交的状态/进度；流式的部分结果是临时的。

状态：queued（排队中）、running（运行中）、succeeded（成功）、failed（失败）、cancelled（已取消）、interrupted（已中断）。视图/取消订阅
不会取消工作；请调用 `cancel`。禁用/重启会中断**所有未完成的任务**，即使是
已禁用包中排队/已保存的任务。不承诺自动重放、DAG/调度器，也不承诺在
应用关闭时执行。`data/tasks/` 保留用于记录。

在 `registerTools.create(context)` 内部，`ctx.createBackgroundTool(context, spec)` 返回
一个原生工具，它带有 worker ID、纯函数 `prepare(input, context)`，以及返回
`{text,data?}` 的 `format(outcome, context)`。由宿主推导出的身份始终将其归类为后台工具。
初始的原生结果保持为一条确认信息；之后的模型文本/渲染数据使用
现有的任务/插话投递管线，并遵守待处理的问题和回合边界。
不要在 prepare/format 中执行副作用。

任务结果与投递是分开的。通用结果会在异步格式化之前持久化；
实时投递会等待格式化，但重启后可以投递已持久化的回退内容，而无需
重新运行工具/格式化器。格式化器失败/代码不可用不会改变真实
任务结果的标记。缺失的任务状态会产生如实的失败，而不是伪造的结果。

之后的卡片会设置 `tool.background`。工具渲染器上的 `backgroundPresentation: "collapsed" | "card" | "plain"`
决定其外壳；`mountWorkerResult` 为插件自有的界面提供相同的 `presentation`。
collapsed 是默认值；card 带边框/展开；plain 无边框/
展开。宿主的身份/状态/格式化器错误保持在自定义主体之外。
紧凑的标题由状态图标 + 标签组成，状态可通过无障碍方式获取/显示在工具提示中。可选的
`content` 是一个 HTMLElement 或以 signal 为作用域的挂载；终态状态为 succeeded、
failed、cancelled 或 interrupted。这不会重新设计原生的调研/PDF 卡片。

**共享准入。** 设置 → 智能体 → 模型 → 后台并发请求数（Settings → Agent → Models → Concurrent worker requests）
（`agent.workerRequestConcurrency`，默认 **8**）控制一个进程全局的 FIFO 池，
用于后台模型请求流，而不是整个任务。只接受正的安全整数；
无效值会被拒绝，调高会放行排队中的请求，调低则让活动中的请求完成。
所有脱离会话的 worker 与原生后台 worker 共享该池，即使是 `purpose: "user"`。
直接的老师/摸底/练习与上下文压缩、交互式托管智能体以及插件的原始
推理调用不在其中。许可在原生工具/子任务等待之前结束；排队中的取消
会阻止分发。`purpose` 控制的是同意，而不是池的归类。

独立任务以 **插件名称 · worker 定义 ID** 的形式显示在后台智能体中，
不会附带虚构的会话链接；已关联的后台工具任务不会产生重复的行。
END 会取消正在计算/排队中的工作，而不会取消已完成的结果或待投递的内容。

## 事件、恢复与测试

后端 `ctx.events.on` / 前端 `ctx.onAppEvent` 观察受支持的应用事件。
`turn-settled` 发生在回合持久化之后，而不是在异步提取完成之后。
后端 `ctx.events.emit(topic, jsonData)` 通知本插件前端的
`onNotification`。这是实时投递，而不是持久的任意事件日志。重新连接时，
请使用 `onResync` 并获取状态。在清理时释放订阅；避免递归触发 emit。

在分发之前，请检查类型、构建出的包布局、禁用状态下的发现、启用/禁用、
重启、清理/延迟的 await、缺少渲染器时的回退以及保留数据的更新。请测试
你的功能所使用的原生生命周期路径，而不只是它孤立的界面。优先使用一次性的
配置档案和回环服务商；不要仅仅为了测试插件而覆盖已安装的应用。
参见[宿主架构与测试接缝](plugin-architecture.md#测试)。

## 有意设定的限制

不提供插件市场/社区更新器、沙箱/每插件独立进程、热替换、
可编程的核心数据写入、通用界面/表单或原始键盘事件框架，也不会自动重放
被中断的任意工具。平台提供的是机制，而不是功能提示词、
算法、默认值或删除策略；产品决策属于人类。
