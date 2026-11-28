# 插件示例与源码阅读地图

工作流程与生命周期规则请参阅[编写指南](plugin-authoring.md)，公开签名请参阅
[API 参考](plugin-api/README.md)。本页把这些 API 对应到可运行的源码，而不是第二份 API 规范。
构建或试用每个项目之前，请先阅读它的 README：插件是受信任的本地代码，而不是沙箱化的扩展。

## 选择起点

| 从这里开始 | 角色 | 能学到什么 |
| --- | --- | --- |
| [Hello plugin](../examples/plugins/hello-plugin/README.md) | 最小起步示例；无需构建 | 前端激活、一个视图、显式的操作放置、宿主按钮/对话框以及按挂载清理 |
| [UI Showcase](../plugins/ui-showcase/README.md) | 可运行的社区开发者展示库 | 全部 15 个公开 UI 方法、受控值、按方法族的局部重置以及浮层归属 |
| [Flashcards](../plugins/flashcards/README.md) | 核心源码参考 | 一个完整功能：知识/文档输入、持久的 worker 结果、插件自有存储、树、复习界面和设置 |
| [Coding questions](../plugins/coding-questions/README.md) | 核心源码参考 | 教学问题与多次练习提交、受控编辑器、处理观察结果以及已保存结果的渲染 |
| [Drawing Pad](../plugins/drawing-pad/README.md) | 核心源码参考 | 会话上下文操作、快捷键、界面（surface）、学习者提交的图片附件以及感知确认（acknowledgment）的草稿消费 |
| [Rich code blocks](../plugins/rich-code-blocks/README.md) | 核心源码参考 | 条件式代码围栏渲染器、附加指令、设置同步、本地资源以及有界渲染 |

Hello 是最小的入门起点。官方源码项目是主要的完整示例；请按下文中你需要的扩展点阅读对应路线，
而不是照搬整个功能。UI Showcase 是开发者展示库，**不是**随应用发布的核心插件。
[针对性示例](#填补空白的针对性示例)用于填补剩余空白，而不是取代这些主要示例。

## 核心参考不是社区插件包

**`flashcards`**、**`coding-questions`**、**`drawing-pad`** 和 **`rich-code-blocks`**
这四个 ID 保留给随应用发布的核心插件，即使某个核心插件包已被禁用、损坏或缺失也是如此。
提供它们的源码是为了学习和改编，而不是作为社区副本安装。请在 **设置 → 核心插件**（Settings → Core plugins）
中启用应用自带的功能。核心代码由应用更新提供；可写记录位于
`<learning data>/core-plugin-data/<id>/`，与这些代码分开存放。

社区分支（fork）需要**自己的 manifest ID 以及与之匹配的文件夹名**。还要检查贡献/类型标识符、
原生工具名和代码围栏名：只修改插件 ID 并不能解决所有冲突。尤其不要假定分支可以在原插件之外
另行注册 `coding_question` / `coding_problem` 或 `smiles` / `abc` / `tikz`。请遵循相关公开契约中的
归属/准入规则。代码始终使用 `ctx.directory`，可写记录始终使用 `ctx.dataDirectory`；
不要从其中一个推断另一个。

UI Showcase 使用其 README 中的普通社区工作流程。Hello 和各个针对性示例包含可直接加载的
`dist/` 文件。本参考中的任何内容都不会被自动安装、启用或运行。

## 源码布局与前置条件

下载的编写工具包保留了仓库的目录布局：

```text
<kit-root>/
  types/                          # shared, type-only SDK
  docs/                           # guide, API reference and this map
  examples/plugins/
    hello-plugin/
    managed-agent/
    teaching-extension/
  plugins/
    flashcards/
    coding-questions/
    drawing-pad/
    rich-code-blocks/
    ui-showcase/
```

每个 `plugins/<id>/` 项目都**从其规范源文件逐字节导出**，包括 `src/`、`scripts/`、`tests/`、
许可证/声明、manifest、`package.json`、lockfile 以及（如有）TypeScript 配置。生成的或本地的
`node_modules/`、`.sdk/`、`dist/` 和 `data/` 不包含在内。共享 SDK 保留在工具包根目录的 `types/`；
不会复制到每个项目中。请保持此布局不变，使 README/源码链接在仓库和解压后的工具包中都能正常工作。
不要把整个工具包当作一个插件安装。

### TypeScript 项目

对于 Coding questions、Drawing Pad、Rich code blocks 和 UI Showcase，请**在设置 npm 依赖之前**，
把解压后工具包的 `types/` **目录内容**复制到该项目的 `.sdk/` 中。在解压后工具包中该项目的
`plugins/<id>/` 目录下执行：

```sh
mkdir -p .sdk
cp -R ../../types/. .sdk/
```

这些项目通过 `file:.sdk` 使用本地的 `learnharness-plugin-api` 包。这些声明仅包含类型，
绝不是运行时的宿主导入。请另行设置项目的开发依赖以及 SDK 声明的 peer 依赖/类型；
源码导出不提供工具链或已安装的依赖。请查阅 `types/package.json` 获取匹配的 peer 依赖，
而不要随意选择 Pi 版本。缺少这些前置条件时，仅复制 SDK 不足以完成类型检查。

`npm run sdk` **仅适用于源码检出**：它会从带有依赖的 LearnHarness 源码检出中调用
`../../scripts/build-plugin-types.mjs`。下载的工具包不提供这个宿主生成器；在那里请使用上面的
复制步骤。Flashcards 是 JavaScript 项目，完全不需要 `.sdk/`。

### 构建与安装、测试分开进行

依赖就绪后，每个官方源码项目都有仅用于构建的命令，在各自目录中运行：

```sh
npm run build
```

该脚本直接写入项目的 `dist/`，打包运行时依赖并复制所需的资源/声明。构建清理会拒绝符号链接形式的
`dist/` 和位置错误的 `dist/data/`，并保留同级的 `data/`。它不会启动/构建宿主、安装/启用插件、
调用模型或更新核心代码。对于新确定 ID 的社区分支或 UI Showcase，请按照
[社区安装指南](plugin-authoring.md#包与安装)操作；不要安装这四个保留 ID 的参考插件。

## 阅读路线

### Flashcards：一个完整的前端/后端功能

先阅读 [README](../plugins/flashcards/README.md)，了解生成、卡组成员关系、复习/练习的区别以及数据生命周期。

1. [`src/main.js`](../plugins/flashcards/src/main.js)：视图/操作/设置的注册、受控的宿主组件、
   显式的图谱/文件确认、`ctx.documents.toMarkdown` 以及前端/后端调用。
2. [`src/library-tree.js`](../plugins/flashcards/src/library-tree.js)：逻辑条目与树中出现位置的区别、
   选择、稳定的富内容以及本地编辑状态。然后阅读 [`src/review.js`](../plugins/flashcards/src/review.js)，
   了解界面与内容生命周期的分离以及感知键盘的复习控件。
3. [`src/backend.cjs`](../plugins/flashcards/src/backend.cjs)：公开的学习数据读取、
   worker 的注册/启动/订阅/等待、校验、取消以及持久结果的应用。
   [`src/file-generation.cjs`](../plugins/flashcards/src/file-generation.cjs)
   和 [`src/generation-prompts.cjs`](../plugins/flashcards/src/generation-prompts.cjs)
   把分块/协议机制与模型指令分开。
4. [`src/store.cjs`](../plugins/flashcards/src/store.cjs) 负责插件自有的持久化；
   [`src/scheduler.cjs`](../plugins/flashcards/src/scheduler.cjs)、
   [`src/statistics.cjs`](../plugins/flashcards/src/statistics.cjs)、
   [`src/dashboard.js`](../plugins/flashcards/src/dashboard.js) 和
   [`src/practice-queue.js`](../plugins/flashcards/src/practice-queue.js) 负责产品算法与展示。
   这些算法是示例策略，不是宿主 API。
5. [`tests/`](../plugins/flashcards/tests/) 和
   [`scripts/build.mjs`](../plugins/flashcards/scripts/build.mjs)：模拟的宿主接缝、
   领域回归测试以及打包。

经过显式确认后，生成可能产生所配置模型的费用。复习、手动编写和额外练习不会调用模型。
不要仅为了查看这些源码而启动生成。

### Coding questions：原生教学与练习契约

阅读 [README](../plugins/coding-questions/README.md)、
[问题契约](plugin-question-contract.md)和[题目契约](plugin-problem-contract.md)。

1. [`src/contract.ts`](../plugins/coding-questions/src/contract.ts)：分开的教学/练习定义、
   载荷 schema 以及面向模型的执行策略。
2. [`src/backend.ts`](../plugins/coding-questions/src/backend.ts)：`gradeAnswer`
   和 `processSubmission` 的注册。继续阅读
   [`src/runner.ts`](../plugins/coding-questions/src/runner.ts)，了解字面程序参数、工作目录、
   输出上限、取消和清理。
3. [`src/main.ts`](../plugins/coding-questions/src/main.ts) 和
   [`src/editor.ts`](../plugins/coding-questions/src/editor.ts)：渲染器注册、受控编辑器值、
   就绪状态以及编辑按键集成。
   [`src/diagnostics.ts`](../plugins/coding-questions/src/diagnostics.ts) 提供建议性的语法反馈，
   而不是提交关卡。
4. [`src/question-view.ts`](../plugins/coding-questions/src/question-view.ts)、
   [`src/result-view.ts`](../plugins/coding-questions/src/result-view.ts)、
   [`src/solution-view.ts`](../plugins/coding-questions/src/solution-view.ts) 和
   [`src/disclosure.ts`](../plugins/coding-questions/src/disclosure.ts)：已保存的题面、
   输出徽标、教学解答以及有界的挂载清理。
5. [`tests/`](../plugins/coding-questions/tests/) 和
   [`scripts/build.mjs`](../plugins/coding-questions/scripts/build.mjs)：真实的本地进程测试、
   隔离的浏览器测试夹具、打包以及依赖许可证收集。

**代码执行没有沙箱。** 学习者和老师的测试程序以用户权限运行，并继承环境变量。超时和临时目录
并不构成安全隔离。测试通过只是观察结果，不会自动判定正确或结束练习；宿主的原生生命周期仍具有最终决定权。

### Drawing Pad：上下文操作与学习者输入准备

阅读 [README](../plugins/drawing-pad/README.md)、
[视图上下文](plugin-view-context.md)和[会话扩展契约](plugin-session-extension-contract.md)。

1. [`src/main.ts`](../plugins/drawing-pad/src/main.ts)：上下文操作和限定作用域的快捷键、
   捕获的原生界面目标、设置以及提交拦截。
2. [`src/reference.ts`](../plugins/drawing-pad/src/reference.ts) 和
   [`src/poses.ts`](../plugins/drawing-pad/src/poses.ts)：尊重宿主选定的输入、
   揭示/可用状态以及已接受的出题（pose）出现位置，而不是自行重建它们。
3. [`src/state.ts`](../plugins/drawing-pad/src/state.ts) 和
   [`src/submission.ts`](../plugins/drawing-pad/src/submission.ts)：捕获的修订版本、
   感知确认的消费以及附加的原生图片附件。
4. [`src/sheet.ts`](../plugins/drawing-pad/src/sheet.ts)、
   [`src/strokes.ts`](../plugins/drawing-pad/src/strokes.ts) 和
   [`src/geometry.ts`](../plugins/drawing-pad/src/geometry.ts)：插件自有的绘图、
   手势、视口相机以及有界的导出几何。然后阅读
   [`src/capture.ts`](../plugins/drawing-pad/src/capture.ts) 和
   [`src/fonts.ts`](../plugins/drawing-pad/src/fonts.ts)，了解可感知取消的捕获。
5. [`src/backend.ts`](../plugins/drawing-pad/src/backend.ts)、
   [`src/settings.ts`](../plugins/drawing-pad/src/settings.ts)、
   [`tests/`](../plugins/drawing-pad/tests/) 和
   [`scripts/build.mjs`](../plugins/drawing-pad/scripts/build.mjs)：偏好设置、
   公开的学习数据读取、校验、测试夹具以及声明。

绘图状态是按窗口保存的内存状态，而不是可编辑答案的持久存储。提交的接受、图片处理以及模型的
图片能力规则仍由宿主负责。

### Rich code blocks：条件式渲染与打包资源

阅读 [README](../plugins/rich-code-blocks/README.md)，了解记法示例、限制、透明外观以及静态绘图与模拟的区别。

1. [`src/main.ts`](../plugins/rich-code-blocks/src/main.ts) 和
   [`src/backend.ts`](../plugins/rich-code-blocks/src/backend.ts)：条件式
   `registerCodeBlock`、附加指令、已接受的设置以及重新连接时的读取。
2. [`src/contract.ts`](../plugins/rich-code-blocks/src/contract.ts)：方法族选项、
   经过校验的设置、提示词以及输入/输出/缓存限制。
3. [`src/render.ts`](../plugins/rich-code-blocks/src/render.ts)、
   [`src/tex-runner.ts`](../plugins/rich-code-blocks/src/tex-runner.ts) 和
   [`src/tex-worker.ts`](../plugins/rich-code-blocks/src/tex-worker.ts)：延迟加载的资源、
   串行的浏览器 Worker 任务、取消以及易失缓存的生命周期。
4. [`src/svg.ts`](../plugins/rich-code-blocks/src/svg.ts) 和
   [`src/appearance.ts`](../plugins/rich-code-blocks/src/appearance.ts)：重建经过审查的静态 SVG、
   约束引用，并在不信任原始 HTML 的前提下应用感知主题的着色。
5. [`scripts/build.mjs`](../plugins/rich-code-blocks/scripts/build.mjs)、
   [`THIRD-PARTY.md`](../plugins/rich-code-blocks/THIRD-PARTY.md)、
   [`licenses/`](../plugins/rich-code-blocks/licenses/) 和
   [`tests/`](../plugins/rich-code-blocks/tests/)：本地引擎资源、上游改编、许可以及使用真实库的浏览器测试夹具。

渲染不会发起模型请求。TeX Worker 的限制和 SVG 净化是本地的功能防护措施，而不是针对任意插件
JavaScript 的沙箱。

### UI Showcase：全部 15 个 UI 方法

[README 展示库地图](../plugins/ui-showcase/README.md#gallery-map)把所有方法归为 12 个方法族。
从 [`src/gallery.ts`](../plugins/ui-showcase/src/gallery.ts) 开始：

| 领域 | 方法 |
| --- | --- |
| 选择器 | `mountModelPicker`、`mountThinkingPicker`、`mountKnowledgePicker` |
| 写作 | `mountComposer`、`mountDictation`、`mountStandardComposer` |
| 控件/内容 | `mountButton`、`mountBadge`、`mountSettingsRows`、`mountMarkdown`、`mountTree`、`mountWorkerResult` |
| 浮层 | `openMenu`、`openDialog`、`openSurface` |

然后阅读 [`src/main.ts`](../plugins/ui-showcase/src/main.ts) 了解能力检查与放置，
[`src/tree.ts`](../plugins/ui-showcase/src/tree.ts) 了解按出现位置的局部状态与草稿，
[`src/surfaces.ts`](../plugins/ui-showcase/src/surfaces.ts) 了解页面主体/原生目标以及嵌套归属，
[`src/dom.ts`](../plugins/ui-showcase/src/dom.ts) 了解限定作用域的清理。对比
[`tests/fixture.ts`](../plugins/ui-showcase/tests/fixture.ts) 与
[`tests/native.mjs`](../plugins/ui-showcase/tests/native.mjs)，以区分模拟的回调与真实的宿主 UI 检查。

展示库中的发送/停止控件只在本地模拟工作。**语音听写在被显式启动时是真实的**，可能会把音频
发送到所配置的语音服务商，并可能产生费用。知识选择器是真正的宿主控件：显式的来源管理操作会影响
真实的来源，尽管展示库中的选择只保留在本地。请使用合成数据；不要为了查看展示库而启动语音听写。

<a id="focused-recipes-for-gaps"></a>
## 填补空白的针对性示例

这些无需构建的小示例是次要示例，用于演示主要源码没有那么直接展示的机制：

- [Managed Agent](../examples/plugins/managed-agent/README.md)：通过 `ctx.agents` 实现的持久交互式
  对话、待处理输入工具、请求 ID、订阅以及不受导航影响的后端工作。阅读
  [`dist/backend.cjs`](../examples/plugins/managed-agent/dist/backend.cjs) 和
  [`dist/main.js`](../examples/plugins/managed-agent/dist/main.js)，了解受控的输入框（composer）
  以及前端/后端桥接。这不是功能级规模的展示库。
- [Teaching Extension](../examples/plugins/teaching-extension/README.md)：通过 `registerTools`
  添加的附加原生工具、工具渲染器、简单代码围栏以及 `createBackgroundTool` 的派发/结果投递。阅读
  [`dist/backend.cjs`](../examples/plugins/teaching-extension/dist/backend.cjs) 和
  [`dist/main.js`](../examples/plugins/teaching-extension/dist/main.js)。它是针对现有智能体的
  针对性示例，不能替代 Flashcards、编程练习或自定义的学习者输入契约。

显式运行它们的智能体/worker 可能产生所配置服务商的费用。阅读、复制或启用示例并不等于允许发起
模型请求。对于没有路线覆盖的 API，请使用 API 参考和编写指南，而不要臆造示例行为。

## 这些检查能提供什么，不能提供什么

| 项目 | 完成前置设置后的纯插件检查 | 额外环境 / 边界 |
| --- | --- | --- |
| Flashcards | `npm run build`；`npm test`（需满足其额外的 DOM 测试前置条件） | 测试使用了 `linkedom`，但它未在本地声明；由源码检出提供。原生测试工具需要 `puppeteer-core`、Chrome、Electron Node 以及匹配的独立宿主/摘要。 |
| Coding questions | `npm run typecheck`、`npm test`、`npm run build`；`npm run test:browser`（需要 Chrome） | 单元测试会启动真实的本地 Node 进程。浏览器宿主/Markdown 是模拟的。原生教学测试工具需要匹配的独立宿主、Chrome 以及源码检出中的 macOS Electron；它不是练习回合的检查。 |
| Drawing Pad | `npm run typecheck`、`npm test`、`npm run build` | `test:browser` 会导入源码检出中私有的宿主组件/资源及依赖；仅凭导出的工具包无法运行。没有 `test:native` 脚本。 |
| Rich code blocks | `npm run typecheck`、`npm test`、`npm run build`；`npm run test:browser`（需要 Chrome） | 浏览器测试夹具使用构建产物和真实的渲染库，宿主为模拟。没有 `test:native` 脚本。 |
| UI Showcase | `npm run typecheck`、`npm test`、`npm run build` | 原生测试工具需要匹配的独立宿主/摘要、就绪标志、Chrome 和 Electron Node；单元测试中的 UI 记录器不能证明真实的原生布局/焦点。 |

源码导出保留测试以供学习；它**不**保证所有测试都能独立运行。请阅读项目的 README 和测试工具，
了解环境变量和平台假设。Flashcards 和 Coding questions 的原生测试工具会安装使用社区 ID 的
测试夹具，而带有保留 ID 的核心打包宿主不会原样接纳它们；不要把它们当作安装说明或可移植的
核心冒烟测试。仅限宿主的集成测试和私有宿主模块不随这些项目导出。原生打包宿主检查需要另行提供
匹配的宿主，仅有公开的声明 SDK 或构建好的插件是不够的。

请使用一次性的配置文件、合成记录和回环测试夹具。插件检查并不等于真实服务商、硬件、完整 Electron
窗口、安装程序、跨平台或人工功能验收。本地图并不意味着要安装依赖、启动宿主、发起服务商请求或运行验证。
