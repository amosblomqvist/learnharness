# 操作的整个会话视图上下文 — API v1

整个会话的只读上下文是通用基础设施，而不是 Drawing Pad 专用或仅限当前问题的 API。本文描述的是与之匹配的
源码/构建版本。请使用所下载 skill 中的 `bundle.json` 来识别应用；仅凭 API v1 无法识别所有可用能力。
公开类型位于 `src/core/plugin-view-context.ts` 以及与之匹配的仅含类型的 SDK 中。

## 公开入口

会话顶栏操作，或在会话上调用的快捷键操作，会收到只读的
`context.view: PluginSessionViewContext`。键盘调用使用 `placement: "keyboard"`；
启用方式与作用域规则参见[操作快捷键](plugin-authoring.md#动作快捷键)：

```ts
ctx.registerAction({
  id: "inspect-session",
  name: "Inspect session",
  run(context) {
    if (context.surface !== "session") return;
    const view = context.view;
    console.log(view.title, view.messages.length, view.composer.text);
    if (view.input.type === "answer") {
      // The actual native display order, not a consumer-authored shuffle/parser.
      const options = view.input.question.options;
      const selectedValues = view.input.draft.values;
      console.log(view.input.revealed, options, selectedValues);
    }
  },
});
ctx.placeAction({
  id: "inspect-session",
  actionId: "inspect-session",
  location: "top-bar",
  sessions: ["teaching", "practice"],
});
```

现有的 `placement`、`surface`、`sessionId`、`kind` 和不透明的 `surfaceTarget` 保持不变。
侧边栏/图谱上下文以及插件自有视图的操作上下文不会获得宿主会话快照。插件自有视图保留其所有者/视图身份；
其私有状态本就归所属插件所有。不存在针对任意插件 DOM 的自动序列化器，也没有新的插件视图上下文提供者协议。

## 整个视图，而不只是一次提交

`PluginSessionViewContext` 包含：

| 字段 | 含义 |
| --- | --- |
| `sessionId`、`kind`、`title` | 底层会话的身份、教学/练习类型以及当前已提交的标题。 |
| `messages` | 完整的、已分离的当前浏览器原生历史记录，可见范围与提交上下文中的消息相同，可能包含流式传输中的或乐观的内容。 |
| `transcript` | 现有的宿主投影对话记录（`LhViewMessage` 数据），包括其分组和各部分。不是 DOM 序列化、截图或独立解析的对话记录。 |
| `status` | 现有的会话状态：`ready`、`submitted`、`streaming` 或 `error`。 |
| `reconciliation` | 现有的规范同步状态：`ready`、`syncing` 或 `failed`。 |
| `busy`、`compacting` | 当前宿主的回合/对账状态以及上下文压缩状态。 |
| `phase` | 当前显示的 `probe`、`plan`、`teach` 或 `practice` 阶段。 |
| `contextTokens` | 现有的已完成对话的上下文用量估计，或 `null`。 |
| `queuedSteers` | 当前可见的、排队中的学习者插话，带有 `id` 和 `text`。 |
| `composer.text` | 输入框中尚未发送的确切文本，即使问题/题目占用了停靠区也会保留。 |
| `input` | 宿主选定的当前输入、其适用的展示状态以及学习者尚未发送的值。 |

历史记录**不**限于面向学习者的问题字段。它可能包含工具参数、承诺、推理、自定义载荷以及其他已暴露的原生
记录。这个面向受信任本地插件的 API 不会建立新的保密边界，也不承诺规范持久化、已接受的投递或恰好一次语义。
投影对话记录的各部分是视图模型数据；最终渲染仍可能隐藏待处理的部分，改为显示停靠区。这两个字段都不代表
每个字节当前都已绘制在视口中。

## 当前输入与学习者尚未发送的输入

`PluginSessionViewInput` 复用现有的提交目标类型，包括确切的
`{messageId, contentIndex, toolCallId, toolName}` 出现位置、会话身份、适用的通道以及现有的不透明界面目标。
它**不是**一次提交尝试。

- **`text`**：现有的普通内容目标。保留的草稿是 `view.composer.text`。
- **`answer`**：原生的面向学习者的 `question`，带有实际显示的/打乱后的选项顺序、Markdown 上下文、
  适用的选项说明、确切的出现位置以及可选的 `questionType`。另加 `expanded`、`revealed`、`available` 和 `draft`。
  `PluginNativeQuestionViewDraft` 包含 `dontKnow`、稳定的已选 `values`、`otherSelected`、`other`、`text`、
  `thinking`、`readingThinking`，以及可选的、按显示值给出的数字 `confidence`。即使“其他”行未被选中，
  其文本也会保留。这些值是原始草稿，而不是规范化/已评分的答案封装；空白不会被裁剪。
- **`thinking`**：现有的原生练习目标/题述以及确切的出现位置，另加 `expanded` 和 `draft.thinking`。
- **`plugin-question-answer`**：现有的插件问题目标身份/元数据，另加已保存的 `input`（包括载荷）、
  `expanded`、`revealed`、实现是否可用的 `available`，以及 `draft: {answer, thinking, readingThinking}`。
- **`plugin-problem-submission`**：现有的插件题目目标身份/元数据，另加已保存的 `input`（包括载荷）、
  `expanded`、实现是否可用的 `available`，以及 `draft: {submission, thinking}`。
- **`unavailable`**：宿主无法解释/读取待处理的输入。带有 `expanded`、`revealed`，以及已知时的确切出现位置。
  它不会臆造输入框/原生回退，也不会凭空制造可作答的契约。

自定义的 `answer`/`submission` 草稿状态就是实际发布的编辑器状态：
`{status:"empty"}` 或 `{status:"unready"|"ready",value:JsonValue}`。有限的 JSON 假值和空值保持原样。
插件尚未发布的私有编辑器状态不会通过检查其 DOM 来读取。外部的插件私有未发送材料同样不会被静默收集。
这些字段仅供参考；无论是 `available` 还是编辑器的 `ready` 状态，单独都不授予提交权限。

原生问题的结构化 `question` 使用现有的 `ClientQuestion` 投影，不包含其答案键/解析/已提交的答案。完整的历史记录
仍然单独提供，没有人为过滤。揭示/折叠标志**描述**的是宿主 UI：未揭示的问题数据仍然可以查看，但读取绝不会
打开/揭示问题。决定把哪些内容渲染为学习者参考的使用方，必须依据所提供的标志和自身的产品行为，而不能把
可查看的数据当作已经可见。

## 快照、身份与生命周期

- 实际的操作调用会在调用插件 `run` **之前**捕获一份新快照。在 await 期间/之后重新读取 `context.view`
  会返回同一份已分离的快照；它不会跟随导航、更新的出现位置或之后学习者的编辑。
- 快照的数据是递归只读/冻结的。原生历史记录、投影对话记录、输入/载荷以及草稿值都与实时宿主状态分离。
  捕获不会授予 setter、提交回调或私有组件句柄。
- 现有的不透明界面目标仍是实时的宿主能力。它们有意不做 JSON 克隆或冻结。已捕获的目标仍指向其原始的底层
  视图；之后的使用受常规界面生命周期规则约束。过期的视图不能静默替换为新会话的内容。
- 动态的 `disabled(context)` 判定收到相同的只读结构。其渲染时快照是延迟生成的，并在该次渲染中共享；
  最终的点击/快捷键会重新捕获并再次检查禁用状态。宿主输入所有者在其公开的展示/草稿发生变化时，会通知
  普通的 React 渲染。插件自有的外部状态仍使用现有的 `refreshActions()` 机制。
- 捕获失败由现有的插件操作错误处理机制兜住。如果发起操作的视图在捕获之前已经消失，则不会运行任何操作。

没有公开的订阅/全局可变上下文 API、截图服务、新增的原始键盘快捷键，也没有新的会话状态模型。读取快照不会
结束语音听写、请求麦克风权限、持久化草稿、调用提交拦截器、处理/评分、提交、确认或发送模型请求。它报告的是
当前已输入/已发布的值，而不会强制刷出待处理的语音。

## 宿主实现与测试

`components/chat.tsx` 提供其现有的原生历史记录、投影对话记录、当前会话元数据以及共享的提交目标工厂。
其原生停靠区发布一个私有的视图局部读取器。已挂载的问题/练习组件读取其实际展示状态和基于 ref 的草稿状态；
自定义组件暴露其已发布的编辑器值和可用性。清理按代次（generation）归属。不会引入第二个历史解析器、
独立的打乱逻辑、DOM 检查、全局存储、轮询或对产品插件的依赖。

需要测试：只读/可辨识联合的 SDK 类型、完整的上下文复制、自定义载荷/编辑器状态、不可用的输入、原生输入
所有者的读取、未裁剪的草稿、清理、内联/溢出菜单操作的新鲜度、异步捕获的稳定性、禁用判定以及捕获错误的兜底。
请在隔离的应用配置文件中试用插件实际的顶栏操作和原生/自定义输入。
