# Claude Code

LearnHarness 可以将外部安装的 **Claude Code CLI** 用作模型服务商。这与 Anthropic API 以及内置的订阅连接是分开的。认证、路由、模型访问和计费都由 CLI 负责；LearnHarness **不**保证只使用订阅额度。

## 设置

1. 在 LearnHarness 之外，于 **运行 LearnHarness 服务器的机器** 上、以该服务器的操作系统用户身份，[安装 Claude Code 并完成认证](https://code.claude.com/docs/en/setup)。不需要常驻运行的 CLI 进程。
2. 确保可执行文件能在该服务器的 `PATH` 或常见的用户/原生安装位置中被发现。在 Windows 上，需要一个可直接运行的 `claude.exe`；仅有 `claude.cmd` 不满足要求。桌面应用的启动环境可能与终端不同。
3. 启用 **设置 → 服务商 → 外部 CLI → Claude Code**（Settings → Providers → External CLI → Claude Code）。这项全应用范围的选择性启用**默认关闭**。使用 **重新检查**（Check again）刷新安装状态。
4. 选择一个 Claude Code 模型：`opus`、`sonnet`、`haiku` 或 `fable`。这些是 CLI 别名，而不是固定的底层版本。

最低版本为 **2.1.259**（[契约](../src/core/contracts/claude-code.ts)）。检查只运行 `--version`，不涉及认证或推理。新启动的模型进程会再次检查，并拒绝过旧/无法验证的版本。通过检查既不能证明账户访问权限、额度、计费方式，也不能证明协议完全兼容。

请在外部安装、更新、登录和切换 CLI 账户。LearnHarness 没有 CLI 账户状态或重新认证的控件。关闭选择性启用会阻止之后的请求，但不会改写模型选择，也不会让 CLI 退出登录；它不会中断已被接纳的回合。正在运行的工作请使用常规的取消操作。

## 哪些内容经过 CLI

LearnHarness 保留对其智能体循环、工具、问题、已保存历史和后台任务的控制。它向 CLI 所配置的服务提供提示词、相关历史和工具结果。

启动器只会移除**由 LearnHarness 密钥存储注入的**凭据。原始启动环境中的凭据、CLI 原生认证和路由仍然可用，并可能影响计费。LearnHarness 不会把它保存的 API 密钥复制给这个服务商。

每个子进程都不经过 shell，在一个空的临时工作目录中运行。LearnHarness 会禁用内置工具、hooks、斜杠命令、CLI 会话持久化和权限提示，并通过一个受 token 保护的回环 MCP 桥暴露它自己声明的工具。流式输出中的工具意图并不足以触发执行：执行需要一个经过认证的 MCP 请求，且其唯一标识、名称和参数都与流中的内容匹配。不存在仅基于 stdout 的回退方式。

这些是集成边界，**而不是操作系统沙箱或服务商政策认证**。用户设置/认证仍然可用。在 CLI 定义了托管设置的地方，托管设置仍然优先。进程关闭时会记录有长度上限的 CLI stderr，因此服务器日志中可能包含 CLI 诊断信息。

### 指令加载

LearnHarness 会在子进程环境**以及**内联设置中强制设置 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`，并固定 `outputStyle: default`。除此之外，用户的认证/路由设置仍然可用。CLI 文档中记载的记忆开关会排除用户/项目/托管策略层级的 `CLAUDE.md` 指令、它们的导入/规则以及自动记忆；它不会移除托管设置。

这些控制依赖于 CLI 遵守它们。在所接受的最低版本 **2.1.259 上，指令隔离尚未经过运行时验证**。官方文档并未说明该开关最早受支持的版本，也未说明确切的启动求值顺序；托管设置的优先级可能高于内联设置。这并不能防范所有插件指令渠道或 CLI 添加的账户上下文。

官方参考：[记忆开关](https://code.claude.com/docs/en/env-vars#variables)、[托管指令文件](https://code.claude.com/docs/en/memory#deploy-organization-wide-claude-md)、[设置优先级](https://code.claude.com/docs/en/settings#settings-precedence)，以及[设置中的环境变量值](https://code.claude.com/docs/en/settings-reference#env)。

## 问题、复用与取消

具有权威性的是持久化的 LearnHarness 对话记录，而不是 CLI 保存的会话。子进程通常在给出最终响应后退出。当工具在等待结果时（包括等待学习者回答问题），它可以保持存活；并且只有在属于同一所有者/会话，且历史、工具、模型、提示词、推理强度和环境都兼容时，才会被恢复使用。

被保留的子进程在空闲 **10 分钟** 后过期。CLI 的 MCP 超时时间为 **30 分钟**，这是为了留出余量，而不是通用的模型截止时间。如果在超时/重启/配置变更后没有可用的子进程，下一次调用会全新启动，并将当前历史作为带标签的 user/assistant/tool 文本重放，同时保留用户/工具图片。这不是 CLI 的 `--resume`，也不能精确还原原生角色/思考内容。已被接纳请求的兼容性失败会被报告出来，而不会被重放悄悄掩盖。

中止会终止子进程和当前的流。取消一个排队中的工具请求可以阻止它之后被接纳，但无法撤销已被接纳的工作。正常退出、失败、中止和空闲过期都会关闭桥接调用/监听器并删除临时目录，必要时会升级进程终止手段。在操作系统崩溃或服务器被强制终止后，不保证能完成清理。

## 用量与故障排查

token 数来自 CLI 流中的用量信息，包括缓存计数。一次尽力而为的本地 CLI 查询可能会报告有效的上下文预算；由于 CLI 的自动上下文压缩，它可能低于模型的标称窗口。缺少元数据时，最大值保持未知，而不会去猜测。

美元费用保持为 **未定价**，菜单中显示 **由 CLI 计费**（CLI billing）。LearnHarness 不会导入 CLI 成功结果行中的美元总额；内部的零费率只是占位符，并不代表推理免费。请自行核实实际费用和权益。参阅[计费说明](compaction-accounting.md)。

| 症状 | 检查 |
| --- | --- |
| 模型缺失/不可用 | 开启选择性启用；检查在服务器的操作系统用户/环境下能否发现可执行文件。 |
| 未找到、未检查或需要更新 | 修复/更新外部可执行文件，然后点击 **重新检查**。有时限的版本探测会在五秒后超时。 |
| 满足最低版本但请求失败 | 在外部检查原生认证、路由、模型访问和额度。 |
| MCP 标识/接纳错误 | 排查已安装 CLI 的兼容性；不要绕过桥的接纳检查。 |
| 回答时启动了新进程 | 在空闲过期、重启或复用校验失败后属于预期行为。 |
| 没有上下文最大值/美元估算 | 缺少预算元数据或由 CLI 控制计费—并非零用量。 |

## 在 Claude Code 中使用 LearnHarness

反方向也可以：让 Claude Code 读取你的学习记录，或在 Claude Code 中开发本仓库。

- **学习数据技能**：仓库根目录的 [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) 把 [`skills/learnharness`](../skills/learnharness/SKILL.md) 发布为 Claude Code 插件。安装后，Claude Code 能以只读方式查询本机的会话、回答、把握度、命题与推理链（需要 Python 3.10+）：

  ```sh
  claude plugin marketplace add /path/to/learnharness   # 本地克隆的路径；也可以填包含该文件的 GitHub 仓库 owner/repo
  claude plugin install learnharness@learnharness
  ```

- **开发本仓库**：根目录的 [`CLAUDE.md`](../CLAUDE.md) 导入 [`AGENTS.md`](../AGENTS.md)，Claude Code 会自动加载其中的仓库规则。它不会影响作为模型服务商运行的 CLI：那些子进程在空的临时目录中运行，并强制设置了 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`。

## 维护者入口

[`src/agent/claude-code/`](../src/agent/claude-code/) 包含发现/启动、流适配、MCP 接纳、复用、重放和上下文窗口探测。引擎在 [`models.ts`](../src/agent/models.ts) 中注册；凭据来源处理位于 [`auth-env.ts`](../src/core/auth-env.ts)。设置中的状态由 [`server/claude-code.ts`](../src/server/claude-code.ts) 提供。

`tests/claude-code-*.test.*` 测试套件使用合成的 CLI 进程和 MCP 请求。它们覆盖的是适配器契约，而不是真实账户的使用资格、服务商审批、计费或课程质量。
