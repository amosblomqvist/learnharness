# 编程题

一个用于 **教学问题和编程练习** 的 LearnHarness 插件，提供语法着色的代码编辑器、可选的初始代码、预先提交的 Markdown 参考解答，以及由智能体编写、在提交时自动运行的测试。智能体会审阅确切的代码、单独的思考内容以及记录下来的测试观察结果。练习允许多次尝试；只有原生的 **conclude** 工具会评估并结束题目。

**本地代码执行没有沙箱隔离。** 老师编写的测试代码和学习者的代码以 LearnHarness 的用户权限和继承的环境运行：它们可以访问文件、网络和已安装的程序。临时工作目录、超时和输出限制只是运行层面的保障，而不是安全隔离。只用于你信任的代码。

## 核心插件与要求

在 **设置 → 核心插件**（Settings → Core plugins）中启用编程题（Coding questions）。它的代码随应用一起发布和更新；可写的插件文件位于 `<learning data>/core-plugin-data/coding-questions/` 下。这个源码项目是参考材料，而不是可安装的社区插件副本。`coding-questions` 是保留的核心插件 ID，即使被停用或缺失也是如此。社区分支需要自己的清单/文件夹 ID，并且必须重新考虑可能冲突的贡献项/类型 ID、工具名称和围栏代码块名称；仅仅修改软件包 ID 并不会重命名 `coding_question` 或 `coding_problem`。不要把此构建安装到社区插件的 `plugins/coding-questions/` 文件夹中。


需要一个相匹配的 LearnHarness 构建，提供公开的原生问题评分 API（带 `gradeAnswer` 的 `registerQuestionType`）、`registerQuestionRenderer`、练习 API（带 `processSubmission` 的 `registerProblemType` 和 `registerProblemRenderer`），以及 `ctx.ui.mountBadge`/`ctx.ui.mountMarkdown`。此版本需要两种注册都可用。“测试输出”和教学中“参考解答”的确切放置位置使用可选的已回答/已提交 `footerContainer` 插槽；不提供这些插槽的兼容宿主会保留一个可读的正文回退方案。清单中的 `minAppVersion` 只是一个数字基线，并不能证明宿主提供了每一项所需的能力。请使用与宿主相匹配的文档和类型。

运行时、编译器、shell 以及任何所需的库都必须已经安装在用户的机器上。本插件不捆绑其中任何一项，也不安装任何东西。程序通过应用进程的 **PATH** 解析（它可能与交互式终端中的不同），或者通过老师提供的显式可执行文件路径解析。没有版本检查工具、运行时目录、软件包安装器或按语言划分的运行器表。

仅构建插件的构建会直接写入本项目的 **`dist/`**，其中包含 `manifest.json`、`main.js`、`backend.cjs`、`styles.css`、`assets/` 和许可证声明。清理只替换 `dist/`，并会拒绝符号链接形式的 `dist/` 或放错位置的 `dist/data/`；同级的 `data/` 会被保留。构建不会安装、启用或更新核心插件。应用打包是单独的宿主操作。

## 问题与测试契约

本插件只向 **老师** 提供 `coding_question`，不向摸底智能体或练习智能体提供。练习智能体另外获得 `coding_problem`（见下文）。原生工具会收到宿主的 `question`、`type`（`predict`/`check`）、`nodeId`，以及以下载荷：

```ts
{
  language: string;
  starterCode?: string;
  modelSolution: string; // Markdown with fenced solution code and optional explanation
  tests: {
    program: string;
    args: string[];
    code: string;
  };
}
```

每个 **新** 问题都需要测试和一个非空的 Markdown **modelSolution**，并在最初的出题调用中编写。解答包含围栏代码块形式的参考代码，并可以附带讲解；它与问题一起保存，在待作答界面中隐藏，只在提交后显示。它不会被执行，也不会被自动测试。没有它的已有问题保留原始数据，并且没有“参考解答”展开开关。

缺少或为空的初始代码会从空白开始；学习者提交的是完整代码，而不是差异。允许提交未修改的初始代码。就绪条件是代码中含有非空白内容，而不是通过语法检查或通过测试。编辑器的换行符会统一为 LF；其他空白字符保持不变。

对于有效的提交，在保存并让老师继续之前，插件会：

1. 创建一个全新的 `data/test-runs/<questionId>/attempt-…/` 工作目录。
2. 以 UTF-8 把提交的确切代码写入 **`answer.txt`**。
3. 用字面的 `tests.args` 启动 `tests.program`，**不使用隐式 shell**，并把 `tests.code` 发送到它的标准输入。工作目录就是这次全新的运行目录。
4. 记录退出状态，以及 stdout/stderr **每个流最多 64 KiB** 的输出，多余的输出会被读取并丢弃。文本按 UTF-8 解码；被截断的不完整末尾字符会被省略。强制执行 **30 秒** 的进程期限。
5. 删除这次尝试的目录，包括编译器输出和在其中写入的其他文件。空的问题目录可能会保留。宿主保存被接受的回答和评分结果，并让常规的老师继续。

不需要维护任何特定于语言的执行约定。老师选择一个已安装的解释器或 shell，并编写完整的驱动/测试代码。例如，Python 测试可以在最初的工具调用中这样提供：

```json
{
  "language": "Python",
  "starterCode": "def square(x):\n    pass\n",
  "modelSolution": "```python\ndef square(x):\n    return x * x\n```\n\nMultiply the value by itself.",
  "tests": {
    "program": "python3",
    "args": ["-"],
    "code": "from pathlib import Path\nnamespace = {}\nexec(compile(Path('answer.txt').read_text(encoding='utf-8'), 'answer.txt', 'exec'), namespace)\nassert namespace['square'](3) == 9\nassert namespace['square'](-2) == 4\nprint('Two supplied tests passed')\n"
  }
}
```

对于 C++，老师可以选择 `program: "sh"`、`args: ["-s"]`，并发送一段 shell 脚本：它写出一个包含 `answer.txt` 的小型测试驱动，调用用户的编译器，然后运行可执行文件。JavaScript 可以使用 `node` 加 `["-"]`；其他语言则使用任何能够解释或编译所提供驱动代码的已安装工具。老师有责任切实地检查答案，并在测试失败时以非零状态退出。shell 是一种显式的程序选择，绝不是运行器的字符串插值。测试不得安装/下载运行时、编译器或软件包，也不得更改机器配置。不需要单独的老师工具调用或工作区管理步骤。

### 结果与生命周期

保存的评分结果采用以下由产品定义的 JSON 结构：

```ts
{
  status: "passed" | "failed" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  message?: string;
}
```

退出码为 0 时显示绿色的 **测试通过**（Tests passed）徽章；非零时显示红色的 **测试未通过**（Tests failed）。程序缺失、启动错误、超时或意外的信号终止会显示中性的 **无法运行测试**（Could not run tests）。意外的评分器/工作区故障会被宿主记录为 `grading.error`，同样采用中性的展示。所有这些已完成的结果都会接受回答并让老师继续；它们不是校验拒绝。它们描述的是所提供的测试，**而不是正确/错误**，也没有分数。

徽章紧跟在宿主标题中的 **编程问题**（Coding question）之后，与原生问题的结果一样。可选的公开 `mountAnswered` `headerContainer` 插槽归该挂载所在的宿主代际所有；不提供它的旧版宿主会保留正文位置的回退方案。不会查询或修改周围的任何宿主 DOM。

在已回答的卡片中，顺序为 **原始问题 → 提交的代码 → 你的思考 → 测试输出 → 参考解答**。原始保存的 `input.question` 始终通过公开的宿主 Markdown 渲染器渲染在代码上方，已有的历史记录中也是如此；不需要新的存储、迁移或重新生成问题。两个展开项初始都是关闭的，并使用低调的、与内容同宽的文字按钮，与原生小测的 **为什么**（Why）控件一致：继承的 UI 字体、11px 文字，以及只改变文字的悬停反馈。没有展开箭头、大写样式或整行背景。展开后的标签为 **收起测试输出**（Hide test output）和 **收起参考解答**（Hide model solution）；原生按钮的 Enter/空格激活和可见的键盘焦点都会保留。

只有在捕获到文本、错误消息或截断提示时才会显示测试输出。非空的 stdout/stderr 使用一致的代码块框和代码排版，每个流最高 16rem，超出后滚动；空白字符会被保留，空的流不会显示框。输出绝不会被当作 HTML 解释。参考解答使用公开的宿主 Markdown 渲染器（包括围栏代码和讲解），只在展开时挂载。两个展开项共享可选的公开 `footerContainer`，它是位于宿主思考输入框下方、归宿主代际所有的区块；没有这个插槽时，插件会保留可读的正文回退方案，而不是移动或查询宿主 DOM。没有重新运行控件、自动重新评分或参考解答的执行。

宿主负责提交准入、持久化和后续继续。停止、停用插件以及失去提交权限都会取消评分，并且不保存回答；仅仅是页面导航不会取消它。保存失败/被取消的提交需要学习者显式重试，这可能会再次运行测试。因此，测试应当可以安全地重试；执行并不保证恰好一次。在代码编辑器之外，Escape 会弹出宿主现有的 **放弃这道题目？**（Dismiss this question?）确认框。“取消”/Escape 会保留草稿；确认只会跳过所捕获的那一次问题出现，而不会开始老师的回合。如果测试正在运行，同一个服务端请求会校验目标、暂存其放弃操作，并在返回之前停止这次运行。过期的确认无法停止或跳过后续的问题。常规的浮层/语音听写的 Escape 优先级保持不变。进程树终止是尽力而为的：POSIX 进程组会被终止，但创建了独立会话的进程可能会存活；Windows 的进程树终止使用 `taskkill`；平台行为需要原生测试。逃逸的进程无法在期限到达或取消之后，通过继承的输出管道让运行器无限期等待。写在运行目录之外的文件不会被删除。

没有已保存评分要求的历史问题保持未评分状态；它们不会被追溯执行或改写。新的已评分快照使用宿主的协议 2，而本插件兼容的问题契约仍为版本 1。**在有待处理的已评分问题时，不要降级宿主：** 旧版宿主可能会取消一个无法读取的协议 2 问题，而不只是将其显示为不可用。

## 编程练习

练习智能体会获得 **coding_problem** 出题工具，它被单独注册为题目类型 `code`，标签为 **编程题目**（Coding problem），契约版本为 1。插件/软件包名称仍为 **编程题**（Coding questions）。老师的工具和已有的教学历史保持不变。宿主提供以下通用字段：

```ts
{
  statement: string;
  mode: "recall" | "discrimination" | "composition";
  target?: string[];
  modelSolution: string; // committed Markdown solution, revealed only by conclusion
  payload: {
    language: string;
    starterCode?: string;
    tests: { program: string; args: string[]; code: string };
  };
}
```

语言和测试是必需的。参考解答是 **宿主通用字段**，绝不会在插件载荷中重复。它在出题时就已提交，并且绝不会被执行。题目陈述保留在宿主持久化的题目卡片中；不会在每次提交时重复。输入区使用相同的编辑器、诊断和编辑按键，后面是宿主的 **你的思考**（Your thinking）和一个 **提交**（Submit）按钮。没有阅读/显示阶段。

每次非空的提交都会针对 `answer.txt` 运行相同的流程，具有上文描述的相同限制、权限和清理。每次全新的尝试目录都归组在 `data/test-runs/<problemId>/` 下。提交的确切代码、单独的思考内容以及 `processing: {result: CodingTestResult} | {error: string}` 会在一次常规的练习继续之前由宿主保存。测试失败和运行错误是对已接受尝试的观察结果，而不是准入拒绝或最终的正确性评估。

学习者可以在同一道活跃的题目上反复修改和提交。接受后会保留编辑器的值/撤销状态以便迭代；宿主只会清除未发生变化的已捕获思考内容。原生题目和插件题目共享同一个活跃题目闸门。**只有现有的 conclude 工具** 会评估/结束题目，并在原生的结束卡片中显示最初提交的参考解答。通过测试绝不会自动结束题目，单次尝试也没有“参考解答”展开开关。

每次保存的尝试都会显示只读代码及其“测试通过/测试未通过/无法运行测试”的标题徽章。顺序为 **提交的代码 → 你的思考 → 测试输出**。测试输出使用与教学中相同的低调、初始关闭的展开项，以及隐藏空输出的策略。它使用公开 `mountSubmitted` 位于宿主图片/思考下方的 `footerContainer`，以及用于徽章的 `headerContainer`；任一插槽缺失时都有正文回退方案。提交后续修订时，较早的尝试绝不会被覆盖或重新处理。已保存记录中缺少处理结果时，不会凭空生成徽章，也不会追溯运行测试。

取消遵循宿主的处理 signal 和现有的运行器清理；失去权限之后，迟到的结果都不得保存。仅仅是页面导航/断开连接不会取消已接受的工作。显式重试可能会再次执行测试。缺失/已停用/不兼容的插件会让活跃题目保持不可用，而不是用原生文本编辑器代替；学习者可以使用原生的练习放弃功能。在代码中按 Escape 会跳到思考输入框；在代码之外按 Escape 则使用原生练习的确认框/层级优先规则。

## 编辑器与原生问题行为

宿主提供 Markdown 问题展示、卡片、显示/折叠、思考和阅读思考输入框、麦克风、模型/推理强度控件、“提交答案”（Submit answer）和仅用于恢复的“放弃”（Dismiss）、原生持久化，以及老师的后续继续。**语音听写始终指向宿主的思考输入框，绝不会指向代码。** 检查类问题保留“先阅读再显示”的流程。宿主会把学习者的思考与插件的代码/结果展示分开放置。

精简的 CodeMirror 6 编辑器包含低调的行号、撤销/重做、括号匹配、四空格的 Tab 缩进以及换行自动缩进。**在代码中，Enter 和 Shift+Enter 都会插入换行**；**Cmd/Ctrl+Enter 通过宿主提交**。宿主的思考输入框保持 Enter 提交、Shift+Enter 换行。插件只处理编辑按键，不实现任何提交操作。**在活跃的代码编辑器中按 Escape 会把焦点移到“你的思考”**，不会打开放弃对话框，也不会改变草稿。在那里按 Enter 即可提交；Tab 继续宿主的字段循环（检查类问题为：阅读思考 → 代码 → 你的思考；预测类问题为：代码 → 你的思考）。在代码中按 Tab 仍然是缩进。Shift+Tab 保持为宿主的模型推理强度快捷键。这只是字段导航，并不是对应用范围内浏览器 Tab 顺序的重新设计。长行会水平滚动。不包含自动补全、自动插入括号、格式化工具、折叠控件、运行/复制工具栏或 IDE 服务。

### 实时语法反馈

Python、JavaScript、TypeScript、C、C++、Java、Rust、Go 和 JSON 会从捆绑的解析器获得建议性的语法反馈。`js`、`ts` 和 `cpp` 等目录别名遵循规范语言策略。停止输入 300ms 后，解析器发现的问题会以红色下划线或点状标记显示，悬停时显示 **“语法问题。”**（“Syntax problem.”）提示。没有额外的边栏、问题面板、快捷键、自动修复或代码修改。已保存的只读回答不会显示诊断。

这是解析器反馈，而不是编译器校验或类型检查。没有标记的回答仍可能包含错误；大型回答使用可用的已解析区域，而不会强制解析整个文档。其他语言只保留语法高亮；特别是，捆绑的 SQL 解析器并不是 SQL 校验器。诊断绝不会阻止提交。

完整的标准 `@codemirror/language-data` 目录在本地随插件发布。语言别名会按需加载语法高亮；未知语言或加载失败时仍可作为纯文本使用。没有语法高亮下载、语言设置或语言限制。CodeMirror One Dark 配色位于一个跟随宿主主题的等宽字体框内。

待作答的问题/题目以及已提交的回答/尝试都是持久化的宿主记录。未提交的代码和思考内容使用 **宿主的内存草稿**：在会话模型存活期间折叠/重新挂载会保留草稿，但模型被销毁、重新加载和应用重启时则不一定保留。插件没有自定义的持久化回答存储、后端 RPC、视图或设置。

## 开发

在解压后的编写工具包中，请在 **准备依赖之前**，把共享的 **工具包根目录下 `types/` 的内容** 复制到本项目的 `.sdk/` 中。在 `plugins/coding-questions/` 下运行：

```sh
mkdir -p .sdk
cp -R ../../types/. .sdk/
```

如果是在 LearnHarness 源码检出中，则改用 `npm run sdk`，它会使用 `../../scripts/build-plugin-types.mjs` 生成 `.sdk/`。该命令 **仅限仓库检出**；解压后的工具包不包含宿主生成器。SDK 只包含类型，绝不会在运行时被导入。

请单独准备开发依赖，包括 SDK 声明的 peer 依赖/类型。这份源码参考和 LearnHarness 都不会自动安装它们。在依赖已就绪的情况下，仅构建的命令是：

```sh
npm run build
```

构建会打包 JavaScript 依赖，输出 ESM 前端/CommonJS 后端以及本地的 `assets/` 分块，并包含第三方许可证声明。它不需要私有的宿主导入，也不需要构建宿主应用。

## 测试与边界

完成 SDK/依赖准备之后，以下是仅针对插件的检查：

```sh
npm run typecheck            # strict public SDK consumer, skipLibCheck=false
npm test                     # real local Node processes, including timeout cases
npm run build
npm run test:browser          # built plugin in a disposable Chrome fixture
```

单元测试覆盖契约、解析器诊断、运行器的字节/参数/环境、工作区清理、启动错误、输出限制、超时/取消、注册以及结果解析。它们会执行真实的、受信任的测试程序；这些测试没有沙箱隔离。浏览器测试夹具覆盖编辑按键、草稿、已保存的教学/练习展示、徽章、输出/解答展开项以及清理。它需要本地的 Chrome/Chromium（`CHROME_PATH` 或受支持的默认路径），并模拟宿主（包括 Markdown 挂载）。它不会测试真实宿主的提交权限、Markdown 渲染、练习继续或原生的结束流程。这些需要在仓库检出中进行宿主集成测试，而不能只靠这个导出的项目。

`npm run test:native` 是面向仓库检出的教学测试工具。它需要已构建的插件文件、`LH_STANDALONE` 中一个已构建好的匹配宿主、本地 Chrome，以及检出中的 macOS Electron Node 运行时。宿主必须提供问题评分、练习注册以及已回答状态的 header/footer 插槽。该工具会把宿主复制到一次性存储中，并使用模拟智能体流量和已安装的 Node 测试程序；它不覆盖练习回合。它的测试夹具会安装一个社区版的 `coding-questions` 软件包，这一准入假设与核心打包宿主上保留的核心插件 ID 不兼容。它不是可移植的核心插件冒烟测试，也不是安装社区重复副本的指示。

测试夹具检查不能证明真实服务商下的正确性、麦克风/输入法行为、物理 Electron 窗口的 UX、签名安装包的行为或跨平台执行。请使用合成数据和回环测试夹具，绝不要使用真实的学习者档案或付费服务商。

## API 边界

只使用仅类型的 `learnharness-plugin-api` 导入以及公开的注册/UI 契约。后端执行使用 Node 内置模块，而不是私有的宿主导入。公开的 `gradeAnswer`/`processSubmission` hook 提供由宿主掌管的等待/保存生命周期。可选的已回答/已提交 `headerContainer` 和 `footerContainer` 提供位于标题旁边和宿主思考输入框下方的有界挂载点。公开的 `mountMarkdown` 渲染已保存的问题和教学中的参考解答；原生练习的结束流程会显示其预先提交的解答。插件不添加提交拦截器、worker、单独的智能体、自定义的问题/题目生命周期或结束工具。回答/提交始终是字符串；评分/处理结果始终是单独的元数据。不可用/已停用时的行为以及安全的放弃操作仍由宿主掌管。如果 API 无法支持某项必需的行为，请停下来，请求宿主进行显式修复。

## 源码阅读路线

- [`src/contract.ts`](src/contract.ts)：分开的教学/练习定义、schema 以及面向模型的执行说明。
- [`src/backend.ts`](src/backend.ts) → [`src/runner.ts`](src/runner.ts)：公开的评分/处理 hook、进程执行、取消和清理。
- [`src/main.ts`](src/main.ts) → [`src/editor.ts`](src/editor.ts)、[`src/diagnostics.ts`](src/diagnostics.ts) 和 [`src/question-view.ts`](src/question-view.ts)：渲染器注册、受控编辑器、建议性语法检查以及已保存的问题。
- [`src/result-view.ts`](src/result-view.ts)、[`src/solution-view.ts`](src/solution-view.ts) 和 [`src/disclosure.ts`](src/disclosure.ts)：有界的 header/footer 挂载及其清理。
- [`scripts/build.mjs`](scripts/build.mjs) 和 [`tests/`](tests/)：打包产物、许可证和测试夹具。

参见[示例地图](../../docs/plugin-examples.md)、[编写指南](../../docs/plugin-authoring.md)和 [API 参考](../../docs/plugin-api/README.md)。

## 许可证

AGPL-3.0-only。构建出的软件包包含 `THIRD-PARTY-LICENSES.txt`，用于捆绑的 CodeMirror/Lezer 及其支持库。
