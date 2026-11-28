# 插件定义的练习题目——宿主 API v1

自定义的**练习题目类型**共享原生的练习生命周期，而不是教学问题、第二套生命周期、单独的结论工具或新的评估系统。本文描述对应的源码/构建。用下载的 skill 中的 `bundle.json` 匹配目标应用；仅凭 API v1 无法确定所有可用能力。公开类型位于 `src/core/plugin-problems.ts` 和纯类型的 `learnharness-plugin-api` SDK 中。

## 共享生命周期

- 后端为每种题目类型注册一个出题工具。它**只提供给练习智能体**，并受现有的以包为原子单位的工具名冲突准入规则约束。
- 原生出题与插件出题共享同一个同步的“同时只有一道活动题目”闸门和图谱目标校验。失败的/悬空的出题不会激活题目。已确认的出题会结束当前回合（包括混合工具批次），且不欠自动继续。在确认之前，通用的可折叠工具追踪有意保持不变：其可展开的参数中可能包含已承诺的解答，就像可查看的智能体思考一样。已受理的出题使用只显示题干的题目卡片。
- 每次出题都有 `statement`、`mode: "recall" | "discrimination" | "composition"`、可选的 `target: string[]`、必填的 `modelSolution: string`，以及插件定义的 `payload`。公共字段及其面向模型的描述来自原生练习 schema。
- 宿主把已受理的插件契约持久化在实际出题确认的 `details.pluginProblem` 中。识别历史/活动插件题目依据的是已保存的契约，而不是实时注册表查找或猜测的工具名。不需要第二个问题账本：与教学问题的占位内容不同，练习确认本身已经持久化。
- 一道题目可以接受学习者的多次提交。只有现有的 **`conclude`** 工具会记录模型的最终评估并结束该题目。原生结论卡片会揭示原始出题中已承诺的 `modelSolution`；插件不提供结论工具。
- 常规的练习关闭仍然可用且是静默的。禁用/移除插件、缺少渲染器或声明不兼容的契约，**不会**把题目替换为原生文本编辑器，也不会丢失其已承诺的解答。在兼容的实现恢复之前，或在学习者关闭该题目之前，提交都不可用。

## 后端注册

```ts
import { Type } from "typebox";
import type { PluginBackendContext } from "learnharness-plugin-api";

export function activate(ctx: PluginBackendContext) {
  return ctx.registerProblemType({
    id: "example",
    label: "Example problem",
    contractVersion: 1,
    tool: {
      toolName: "example_problem",
      description: "Pose a practice problem using the example editor.",
    },
    problemSchema: Type.Object({ starter: Type.String() }),
    submissionSchema: Type.String(),
    validateProblem(context) { return undefined; },
    validateSubmission(context) { return undefined; },
    async processSubmission(context) {
      context.signal.throwIfAborted();
      // Run plugin-owned checks against context.submission and the saved input.
      // Return observations, not the host-owned outcome envelope or a verdict.
      return { observedLength: context.submission.length };
    },
  });
}
```
`registerProblemType<Q extends TSchema, S extends TSchema>(definition)` 返回一个注销函数。定义包含：

- 必填的稳定本地 `id`、`label`、正的安全整数 `contractVersion`、`tool`（`toolName`、`description`）、`problemSchema` 和 `submissionSchema`。
- 可选的 `incompatibleContractVersions: number[]`；不兼容的已保存题目保持活动但不可用。未列出的不同版本同样不可用。
- 可选的同步、无副作用的 `validateProblem` 和 `validateSubmission`，返回 `undefined`、`[]` 或可读的错误字符串。异步/thenable 校验不能授予受理。schema 遵循与插件问题相同的有界有限 JSON/本地引用策略。无论是校验还是 schema 准入，都不会对值做类型强制转换/去除首尾空白。
- 可选的 `processSubmission`，可同步也可被 await，返回**有限 JSON**。

题目校验获得只读的 `chatId`、`contractVersion`，以及已受理的公共 `input`（包括由 schema 推断出的 `input.payload`）。提交校验额外获得 `problemId` 和由 schema 推断出的 `submission`。处理阶段再增加 `thinking: string`、可选的 `images: PluginProblemSubmissionImages`，以及宿主拥有的 `signal: AbortSignal`。归属的 JSON 是分离/冻结的；实时信号本身不冻结。不提供私有的回合控制器、历史访问器、计分 API 或 conclude 能力。

### 校验 → 处理 → 保存 → 继续

已保存的 schema 以及在出题时冻结的细化校验/处理要求约束**每一次**提交。所需的实现必须在已保存的契约版本下可用。新增钩子不会追溯性地改变先前所出题目的要求。

宿主同步执行校验，捕获确切的实现，等待可选的处理完成，重新检查权威的题目身份/激活状态，保存一个学习者标记，并启动一次常规的练习继续。该标记分别存储 `submission`、`thinking`、可选的 `images` 和可选的 `processing`：

```ts
type PluginProblemProcessingOutcome =
  | { result: JsonValue }
  | { error: string };
```
`false`、`null`、零以及空 JSON/空字符串结果都是有效的观察结果。普通的抛错、拒绝或返回非 JSON 会在一次**已受理的**提交上成为 `processing.error`。它们既不是答错标志，也不是自动结束题目的理由。模型会读取已保存的观察结果以及提交内容和思考。已存储的观察结果在历史投影、重新挂载、继续或模型重试时永远不会重新计算。

处理使用现有的内联回合准备所有者，而不是后台任务/队列或另一次模型请求。它可以被重新连接，并排斥与之竞争的回合/提交。HTTP 断开/导航不会取消已受理的工作。停止、禁用插件或确切注册的移除会中止其信号，并阻止迟到的保存。在底层回调实际结束之前，所有权一直被持有：插件必须配合取消，并自行负责任何执行超时。模型/服务商的选择在提交被准入时捕获；之后在选择器中的更改应用于下一次请求。插件题目的 POST **不会**在 409 后自动重新提交。保存前失败后的显式重试可能会重新执行处理；没有跨崩溃的恰好一次保证。

## 前端注册与原生停靠区

`ctx.registerProblemRenderer(renderer)` 按插件 ID 和稳定的类型 ID 限定所有者作用域，并带有显式的 `supportedContractVersions`。它返回一个注销函数。

```ts
import type { PluginProblemRenderer } from "learnharness-plugin-api";

const renderer: PluginProblemRenderer<{ starter: string }, string> = {
  id: "example",
  supportedContractVersions: [1],
  mountSubmissionEditor(container, context) {
    const input = document.createElement("textarea");
    input.value = context.submission.status === "empty"
      ? context.input.payload.starter : String(context.submission.value);
    container.append(input);
    const publish = () => context.onChange({ status: "ready", value: input.value });
    input.addEventListener("input", publish);
    publish();
    return {
      update(props) {
        input.readOnly = !props.active;
        if (props.submission.status !== "empty") input.value = String(props.submission.value);
      },
      focus() { input.focus(); },
      dispose() { input.removeEventListener("input", publish); },
    };
  },
  mountSubmitted(container, context) {
    container.textContent = context.submission;
    // Optional context.processing is observational data; display it as desired.
    // context.headerContainer ?? container can host a generic ctx.ui.mountBadge.
  },
};
// During frontend activation: ctx.registerProblemRenderer(renderer).
```
两种挂载都接收已保存的 `input`、`chatId`、`problemId`、`contractVersion` 以及一个 `AbortSignal`。`mountSubmissionEditor` 还接收 `active`、受控的 `submission` 和 `onChange`。状态为 `{status:"empty"}` 或 `{status:"unready"|"ready",value:JsonValue}`。即使某个拦截器有待处理的外部输入，编辑器也必须有就绪值。必需的句柄有 `update`、`focus`、`dispose`；可选的 `handleKeyDown` 和 `appendTranscript` 使用与教学问题相同的编辑器句柄术语。

原生练习停靠区保留其题干，然后在 **你的思考**（Your thinking）上方插入插件编辑器，并只有一个 **提交**（Submit）按钮。受理之后，编辑器的值会保留以便继续修改；只有自捕获以来未改动的思考会被清空。编辑器和草稿在折叠以及一次忙碌的处理/继续周期中都会保留。过期的异步挂载、回调、注册替换和清理都不能修改后继代次。

键盘行为共享现有的插件编辑器归属/IME/层守卫：已处理的按键留在编辑器中；未处理的 Enter 提交，Shift+Enter 为原生编辑，Tab 在宿主字段间循环，未处理的 Escape 直接从编辑器移到思考。保留的 Ctrl/Cmd+Enter 组合键用于提交。编辑器之外的 Escape 保留原生练习的放弃确认优先级。语音听写到思考的功能仍由宿主负责。

`mountSubmitted` 是可选的，接收确切的已受理 `submission` 以及可选的 `processing`；思考/图片仍是宿主拥有的呈现通道。其可选的只读 `headerContainer` 是一个归属于当前代次的内联后缀，位于宿主标签之后，与其共享信号和清理生命周期。可选的只读 `footerContainer?: HTMLElement` 是一个归属于当前代次的块，位于提交卡片底部、宿主的提交图片和思考之后。它同样共享该信号/清理生命周期。用它放置应位于思考下方的输出；`mountSubmissionEditor` 中不提供它。永远不要替换宿主的标题或思考、移动周围的 DOM，也不要跨挂载代次保留任一插槽。如果任一可选插槽不存在，就把其内容挂载到主体中。同步/异步挂载失败、替换、StrictMode 重放和卸载会移除全部三个归属于代次的插槽。失败/缺少渲染器时使用可读的已保存值/观察结果回退；它们不会清除历史，也不会凭空生成成功/正确性徽章。

## 图片与提交拦截器

插件练习提交参与现有的准备流水线：

```ts
// Extract<PluginSubmission, { type: "plugin-problem-submission" }>
{
  type: "plugin-problem-submission",
  submission: /* finite JSON */ "editor value",
  submissionImages: [],
  thinking: { text: "learner reasoning", images: [] },
}
```
对应的目标具有 `channels: ["submission", "thinking"]` 和 `problem: { problemId, occurrence, pluginId, typeId, contractVersion, label, statement }`。身份仍归宿主所有。拦截器可以变换值/思考或附加图片，但不能改投到其他题目。`onAccepted` 只在权威受理之后触发，因此绘图插件可以在取消/拒绝期间保留未发送的笔画，并且只清除已受理的材料。拦截器取消和无效输出都会保留草稿。

传输/保存的图片通道为 `images: { submission?, thinking? }`；reading-thinking 不适用。图片经过现有的结构、字节/MIME、模型能力和缩放准入。实际的原生图片块与带标签的文本一起发给模型；base64 不会被塞进结构化提交或面向模型的 JSON 字符串中。

## 测试

覆盖已保存的契约、共享的原生/插件生命周期/闸门/结论、注册撤销、处理归属/取消/重复提交、图片/拦截器、受控停靠区的清理/草稿、渲染器插槽以及可移植 SDK 的类型推断。在隔离的应用配置文件中运行插件，同时使用组件测试夹具。原生的文本练习行为保持独立。
