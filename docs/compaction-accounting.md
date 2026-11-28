# 上下文、缓存与费用

点击输入框下方的上下文/费用行，即可打开**会话统计**（Session stats）。上下文测量值、缓存命中率和美元估算回答的是不同的问题；它们都不是服务商账单，也不是对下一次请求的保证。

## 对话用量表

分子是最近一次符合条件的已完成对话响应的原生 Pi **输入 + 输出 + 缓存读取 + 缓存写入** token 数。推理已包含在输出中。部分更新、错误、中止、无效计数以及全为零的用量都不会替换上一次的测量值。摘要器的用量从不计入这个用量表。

分母取自所选模型的目录上限。自定义模型使用其固定/上报/回退的预算。Claude Code 则改用 CLI 为本会话匹配模型上报的有效预算（需有效），由于 CLI 的自动上下文压缩，该预算可能更低。缺失的上限保持为未知，不会凭空编造。

切换模型会保留分子，但不会借用另一个模型的 CLI 预算。成功的上下文压缩会使之前的测量值失效：在出现新的符合条件的响应之前，显示 `? / maximum`；CLI 预算元数据也会一并失效。

### 观测到的缓存命中率

展开的会话统计只有在记录到正的缓存读取量且输入有效时，才会显示**缓存命中率**（Cache hit rate）。它是整个会话范围内按提示词 token 加权的比率，而不是各次调用百分比的平均值：

```text
sum(cache read) / sum(fresh input + cache read + cache write)
```

输出不计入；一小时写入是写入的子集，不会重复计算。缺失的缓存计数表示没有记录到复用，而不是证明未命中。它描述的是观测到的用量，而不是缓存是否温热、未来的命中、节省的费用或保留时长。参见 [`sessionCacheHitRate`](../src/core/prices.ts)。

## 提示词缓存保留

在**设置 → 智能体 → 模型 → 显示高级设置**（Settings → Agent → Models → Show advanced settings）下，每个强力/经济/视觉（Strong/Cheap/Vision）槽位都有一个**缓存**（Cache）下拉菜单。隐藏高级设置不会重置它。

| 选项 | 请求行为 |
| --- | --- |
| Pi 默认（Pi default） | 不设置 `cacheRetention`，保留 Pi 的行为，包括在受支持时生效的 `PI_CACHE_RETENTION=long`。 |
| 不请求缓存（Don’t request caching） | 传入 Pi 的 `none` 偏好；服务商仍可能自动缓存。 |
| 短期保留（Short retention） | 传入 Pi 的 `short` 偏好。 |
| 长期保留（Long retention） | 传入 Pi 的 `long` 偏好；缓存写入可能更贵。 |

这些是**取决于服务商的偏好**，而不是固定时长或缓存命中的承诺。有些适配器会忽略它们，订阅传输可能省略它们，自定义端点可能拒绝不支持的参数。LearnHarness 不会换用其他偏好重试。

会话继承强力槽位的保留偏好，同时保留各自的模型选择。后台角色继承其所分配槽位的偏好，即使设置了模型覆盖也是如此；摘要使用对话的偏好。更改会在下一次模型请求时生效，包括已在运行的循环，但不会改变正在进行的调用，也不会发出预热调用。显式选择会覆盖 Pi 的保留环境变量偏好；选择 Pi 默认则会移除显式选择。

对于受支持的 Anthropic 路由，短期/长期分别对应五分钟/一小时，缓存写入的费用是普通输入的 1.25×/2×；读取使用打折的缓存读取价格。更长的保留时间有助于跨越停顿，但对于单次调用或短任务会更贵。其他服务商各不相同。当前的对应关系/价格请参阅 [Anthropic 缓存文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)和 [OpenAI 缓存文档](https://developers.openai.com/api/docs/guides/prompt-caching)。

## 花费

服务器使用 Pi AI 的目录和公开的 `calculateCost`；浏览器收到的是推导出的估算值，而不是单独的费率表。目录更新可能会对历史重新定价，但不会改动已保存的用量。

| 路由 | 含义 |
| --- | --- |
| API 服务商 | 在有目录模型和所需用量明细时给出美元估算。 |
| 内置订阅连接 | 通过显式的逻辑服务商 ID 标注的套餐用量，而不是 API 美元。 |
| [Claude Code](claude-code.md) | 保留 CLI token；美元费用不定价。不导入 CLI 结果行中的美元总额；路由/计费归 CLI 负责。 |
| [自定义/本地端点](custom-providers.md) | 保留 token；费用为未知/未定价，而不是 $0。没有费率编辑器。 |

混合会话会累加已知的 API 估算，并保留订阅/CLI 标注。未定价的回合仍然是未定价，而不是免费。摘要器的花费按相同规则计入，但不会填充对话用量表。

已保存的输入计数是经 Pi 归一化的**新鲜输入**，与缓存分桶互不重叠；不要再减去一次缓存读取。缺少缓存写入保留时长拆分的旧记录，或缺少逐次调用明细、按档位定价的多次调用任务，在该明细可能改变结果时保持未定价。它们不会根据汇总值重建。按统一费率定价的历史任务在计数充足时仍可定价。

## 上下文压缩与维护者参考

上下文压缩会为后续请求总结较早的上下文；原始消息仍然保存。下一次请求的估算与显示的上一次调用测量值是分开的：它以上报的用量为锚点，估算之后的消息，并回退到基于活动对话记录/系统提示词的启发式估算。触发阈值取配置阈值与“目录窗口减去预留”两者中较小的一个。目录窗口未知时只使用配置阈值；CLI 的显示元数据不会改变这个触发条件。

[`src/core/compaction.ts`](../src/core/compaction.ts) 从 **@earendil-works/pi-coding-agent 1.4.0** 移植了截断点选择和默认大小启发式，但不依赖 coding-agent。它向后遍历，直到约 **20,000 token 的保留尾部**，选择一个有效的用户/助手边界，并在尾部的结果需要时保留其前面的调用。文本/思考/工具名/参数按字符数 ÷ 4 计算；图像固定计为 1,200 token。整条消息可能导致超出；这不是精确的大小保证，加密签名既不计量也不剥离。

LearnHarness 保留自己的教学摘要提示词、学习计划连续性、调度、授权和持久化。不丢弃任何历史的截断不会进行总结。请求先包含一次最新的摘要，然后是保留的对话记录；之后的摘要会收到一次先前的摘要以及新被取代的内容。无法确定截断点时，保留现有的全历史回退方案。因输出上限（`length`）而截断的摘要会直接失败，而不是把不完整的输出作为检查点保存。

### 可选的推理感知估算（仅限 OpenAI Responses）

在**设置 → 智能体 → 上下文**（Settings → Agent → Context）下、紧挨着上下文压缩阈值的下方，**在 token 估算中计入推理内容（仅限 OpenAI Responses）**（Include reasoning in token estimates (OpenAI Responses only)）会启用对原生启发式的推理感知扩展。它默认**关闭**，对于没有 `compaction.includeReasoning` 的现有设置也是如此。更改应用于之后的上下文压缩检查，不影响已在进行中的压缩，也不会重新截断现有摘要。

当保留尾部包含不透明的推理内容时，基于可读内容的启发式可能会严重低估，即使服务商用量正确地触发了上下文压缩也是如此。开启该选项后，对于满足以下条件的助手响应，已保存的响应级输出用量会为可读内容估算提供一个**下限**：

- 使用 `openai-responses`，并且与所选模型的 API、服务商和模型 ID 一致；
- 包含至少一个带非空 `thinkingSignature` 的思考块，即使可读的思考内容为空；
- 具有有效的、为正的安全整数输出用量，并且没有出错或被中止。

输出用量已经包含推理：它**每个响应只计一次**，而不是每个思考块计一次，并且不会加到可读估算上。估算器从不把密文长度换算成 token，也不会把整个上下文范围的输入/总用量当作单条消息的大小。其他模型、API（包括 OpenRouter 的 Chat Completions 路由）、未签名的消息以及无法使用的输出读数，保留原来的启发式。

该选项影响回合开始时的关卡和后台结算检查中的保留尾部截断点选择和下一次请求估算，包括上下文压缩使先前的服务商用量锚点失效后立即使用的回退。除此之外，服务商上报的用量锚点保持不变。已保存的输出用量是重放大小的代理指标，而不是对下一次请求的精确测量：两种模式都不保证测得的尾部恰为 20k。阈值、近期尾部预算以及助手/工具/问题边界规则都不变。

该选项**不会**把思考文本加入摘要器的输入，不会剥离签名、改写已保存的历史，也不会改变对话用量表。回归覆盖：[推理核算](../tests/compaction-reasoning.test.ts)、[两个服务入口以及相同快照下的开/关对比](../tests/compaction-service.test.ts)、[设置持久化/默认值](../tests/settings-store.test.ts)以及[设置开关](../tests/render-settings.test.tsx)。该对比使用固定的合成摘要和已保存的用量；它并不测量真实的服务商输入。

### 实现参考

实现：[`server/compaction.ts`](../src/server/compaction.ts)、[`context-usage.ts`](../src/core/context-usage.ts)、[`server/pricing.ts`](../src/server/pricing.ts)。回归测试：`tests/` 下的 `compaction-native-parity`、`context-usage`、`pricing-native-parity`、`subscription-usage` 和 `session-cache-hit-rate`，以及 CLI/自定义服务商测试套件。

## 上游署名

截断点/估算器的移植改编自 `@earendil-works/pi-coding-agent` 1.4.0 中以 MIT 许可证发布的代码，作者 Mario Zechner（据已发布包的元数据）。所检查的 `dist/core/compaction/compaction.js` 的 SHA-256 为 `f51e78ef1da66b5803fc91e185f07b968f8f989ab9326b7744958416aad3f6f6`。

MIT License

Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
