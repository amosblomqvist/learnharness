# 开发

产品安装与设置见[快速上手](getting-started.md)。运行时流程见[架构](architecture.md)。这些指南以[仓库源码](README.md#about-these-docs)为准。

## 环境搭建

CI 和发布构建使用 **Node 26**。请使用 lockfile 以及兼容的原生构建环境：

```sh
npm ci
npm run plugins:setup  # generate local SDKs and install locked source-plugin dependencies
npm run dev            # normally http://localhost:3000
npm run desktop:dev    # Next dev + Electron on localhost:3000
```

`plugins:setup` 会准备 `plugins/` 下的每个源码包：需要时生成其被忽略的 `.sdk/`，然后运行 `npm ci`。在全新检出后运行一次，并在公共 API 或插件 lockfile 变更后再次运行。根目录的类型检查/构建包含插件源码，因此 CI 使用相同的准备步骤。它不会构建插件 bundle，不会在你的学习数据目录中安装/启用插件，也不会填充 `core-plugins/`。

`npm run plugins:build-core` 会构建 `core-plugins.json` 中的四个 ID，并在生成的 `core-plugins/<id>/` 中暂存完整的、由应用拥有的包。`dev` 和 `build` 会自动运行它；`desktop:dev`、`desktop:dist` 和 `dev:fresh` 使用这些入口。核心代码直接从该目录加载；修改源码/重新构建后需重启服务器（插件没有热重载）。不要在未先暂存核心包的情况下直接使用 `next dev`/`next build`。全新检出需要先运行 `plugins:setup` 才能执行这些命令。

`desktop:dev` 会等到开发服务器能响应 HTTP 后才打开 Electron 窗口，其中包括核心包暂存和首个路由的编译。启动总预算为 30 秒；服务器不可用时会在终端/日志中报错并以失败状态退出，而 Next 的开发错误页面仍会正常显示。

对于社区/开发者插件，请在其源码目录中构建，并按照[安装指南](plugin-authoring.md#包与安装)操作。生成的 `core-plugins/`、插件的 `dist/`、`.sdk/` 和 `node_modules/` 都不纳入 Git。UI Showcase 仍是开发者示例，不是随应用发布的核心包。切勿安装使用保留核心 ID 的社区包。

核心数据位于 `<learning data>/core-plugin-data/<id>/`；社区插件的代码/数据仍位于 `<learning data>/plugins/<id>/{dist,data}/`。所有新发现的插件初始均为禁用状态。核心代码从不复制到学习数据目录中，切换到这种布局也不会迁移旧的开发数据。

打开界面不需要任何密钥。在使用由模型驱动的功能之前，请先配置连接以及强力/经济/视觉（Strong/Cheap/Vision）槽位；没有出厂预设的模型选择。支持 OpenRouter，但不是必需的。

```sh
npm run build          # stage core plugins, then Next production/standalone build
npm start              # serve the production build with Next
```

`npm run desktop:dist` 是本地的**已签名 macOS** 打包路径，而不是可移植的未签名捷径。前置条件以及 Windows/Linux 说明见[桌面构建与发布](desktop-release.md)。

### 网络中的其他设备

`npm run dev`、`npm start` 和 `desktop:dev` 只监听 `localhost`。仅浏览器模式**没有登录**：任何能访问该端口的人都可以读取所有对话和设置、修改已保存的密钥，并发起智能体回合。若要在你信任的网络中从另一台设备打开它，请在后面追加 host 参数：

```sh
npm run dev -- -H 0.0.0.0     # then browse to http://<this machine's IP>:3000
```

API 接受 `localhost` 和 IP 地址作为主机名。若要使用其他名称（`mymac.local`、反向代理域名），请将其列入 `LH_ALLOWED_HOSTS`。浏览器发起的写入必须来自与页面相同的源。

## 配置

非机密设置以增量形式保存在 `<data root>/settings.json` 中；缺省值通过 `src/core/settings.ts` 和 `settings-resolution.ts` 解析。模型和角色覆盖属于设置，而不是环境变量。[提示词覆盖](../src/agent/prompts/README.md)位于 `<data root>/prompts/` 下，并且需要显式打开启用开关。

| 变量 | 用途 |
| --- | --- |
| `LH_DATA_DIR` | 可变的对话/后台任务/图谱/设置/提示词；默认为仓库中的 `data/`。 |
| `LH_AUTH_FILE` | 密钥/自定义端点绑定；默认为仓库根目录的 `auth.json`，位于 `data/` 之外。 |
| 服务商 API 密钥变量 | 可选，取决于所选服务商；界面中使用的名称见 `src/core/auth-keys.ts`。 |
| `TAVILY_API_KEY`、`BRAVE_API_KEY`、`EXA_API_KEY`、`FIRECRAWL_API_KEY`、`OLLAMA_API_KEY` | 可选的搜索适配器。未在设置中固定时，第一个配置了密钥的引擎胜出：Tavily → Brave → Exa → Firecrawl → Ollama。固定的引擎需要它自己的密钥；不会静默回退。Ollama 搜索托管在 ollama.com，不是本地模型服务器。页面抓取是独立的；调研无需搜索密钥也能抓取已知 URL。 |
| `DEEPGRAM_API_KEY` | 可选，用于签发语音听写 token。 |
| `CHROME_PATH` | 互动演示验证用的 Chrome/Chromium 可执行文件回退；首选 Electron 的浏览器助手。不会额外下载 Chromium。 |
| `LH_ALLOWED_HOSTS` | 仅浏览器模式：除 `localhost` 和 IP 地址外，API 额外接受的主机名。逗号分隔，不区分大小写，忽略端口，不支持通配符。 |

普通的 Next 开发可以读取 `.env.local`。真实环境中的密钥优先于已保存的密钥。已保存的认证信息是权限受限的明文，而不是加密保险库。打包后的 Electron 在 `userData` 下设置独立的数据/认证位置；它不使用仓库的开发配置。

各服务商的设置与限制：[Claude Code](claude-code.md)、[自定义端点](custom-providers.md)、[上下文/费用核算](compaction-accounting.md)。

### Web/开发环境中的订阅连接

`npm run dev` 和 `npm start` 支持 ChatGPT、GitHub Copilot 和 Grok 登录。`desktop:dev` 使用同样的开发服务器连接；打包后的桌面应用则由一个独立的主进程负责持有凭据，并使用私有传输通道。订阅路由不会回退到按 API 密钥计费。

Web/开发环境会把 `chatgpt-credentials.json`、`github-copilot-credentials.json` 和 `xai-credentials.json` 写在 **`LH_AUTH_FILE` 旁边**，默认在仓库中——而不是在 `data/` 下或全局 Pi 配置中。Git/构建排除规则覆盖这些文件及其写入时的临时文件。刷新的串行化仅限进程内：每个凭据目录只用一个服务器。

ChatGPT 的回调监听器是**服务器所在机器**上的 `127.0.0.1`；请在那台机器上的浏览器中完成登录。Copilot/Grok 使用设备码。如果发起登录的浏览器拦截了登录标签页，请允许它；Electron 开发模式会在系统浏览器中打开服务商页面。已连接的浏览器共享服务器的凭据、后台使用授权、密钥和学习数据。

这是**受信任的本地/共享开发环境**，而不是多用户托管。API 的主机名检查和同源检查可以阻止 DNS 重绑定以及来自其他网站的跨站写入，但它们不是用户认证；那些短时有效、绑定来源、一次性使用的浏览器打开操作也不是。在没有独立访问控制的情况下，不要把服务器暴露给不受信任的用户或公共互联网。按用户隔离、远程 ChatGPT 回调路由以及凭据导入均未实现。

## 安全的本地工作

使用一个可丢弃的数据根目录，以及一个单独的、内容为空 `{}` 的认证文件：

```sh
LH_DATA_DIR=/absolute/path/to/scratch/data \
LH_AUTH_FILE=/absolute/path/to/scratch/auth.json \
npm run dev -- --port 3001
```

这些变量隔离的是应用记录/已保存的密钥，**而不是所有外部影响**。环境中的密钥仍然优先；订阅文件跟随认证目录；Claude Code 可能使用它自己的原生配置。文件工具在服务器用户的权限下拥有广泛的读取权限，受[路径防护](architecture.md#file-access-and-external-services)约束。临时数据根目录不是文件系统或凭据沙箱。自动化复现请使用合成的测试夹具/假服务商，并避免使用个人文件或环境中的凭据。

不要提交 `.env.local`、凭据或学习记录。不要把个人配置复制到测试夹具中。避免对正在使用的配置启用额外的写入者；存储初始化和维护脚本可能修改数据或调用模型阶段。使用脚本之前先检查它们。修改格式之前请参阅[存储与兼容性](architecture.md#storage-and-notifications)。

在做涉及框架的修改之前，请阅读 `node_modules/next/dist/docs/` 下已安装的相关 Next 指南。导入限制位于 `eslint.config.mjs` 中；它们并不强制执行所有架构约定。[架构文档中的代码地图](architecture.md#code-boundaries)和[提示词组合](../src/agent/prompts/README.md)指明了主要入口。对于插件，请从[编写/能力地图](plugin-authoring.md)、[宿主源码地图与验证](plugin-architecture.md)、[`examples/plugins/`](../examples/plugins/) 模板以及 [`plugins/`](../plugins/) 功能源码开始。

## 调试

- `LH_PROVIDER_EVENTS=1` 会把原始服务商事件保存在所选的数据根目录下。其中可能包含私密的课程/服务商内容。
- `LH_BACKGROUND_CAPTURE=auditor`（或逗号分隔的多个角色，或 `all`）会捕获后台请求/结果。角色包括 `researcher`、`demoBuilder`、`extractor`、`auditor`、`visualMaker` 和 `pdfReader`；前台的教学/摸底不在其列。

例如：

```sh
LH_BACKGROUND_CAPTURE=auditor npm run desktop:dev
```

该标志必须传到 **Next 服务器**；要更改它，请重启已有的服务器。捕获默认关闭，写入 `<data root>/debug/background-captures/<role>-<run ID>.json`。每个文件保留最后一次请求以及响应/错误/工具结果，包括该请求中的先前对话以及简洁的逐回合计时——而不是每一个请求体。

`request.format: provider` 表示经过应用传输限制之后、由适配器暴露的出站负载；`context` 表示面向模型的对话，而不是 HTTP 线上格式（例如 CLI）。捕获不会开启思考，也无法找回服务商没有返回的推理内容。请求选项/认证头不会被记录，能识别的嵌套凭据/头字段会被脱敏，POSIX 系统上的文件仅所有者可访问。它们仍然包含私密的来源/图谱内容，**不会自动过期**，分享之前需要审查，不再需要时需手动删除。捕获/序列化错误不会导致工作器失败。

对于前端故障，请检查实际的界面、请求、控制台和状态。仅靠静态渲染并不能证明某个交互可用。

<a id="checks"></a>
## 检查

```sh
npm test               # node:test via tsx; injected engines, fixtures, fake transports
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint, including import restrictions
npm run build          # Next production build
```

测试套件不需要付费模型或真实登录。有些测试会使用临时文件、原生进程或本地假端点：确定性并不意味着每个测试都是纯的，或者不会绑定回环端口。在正在运行的应用旁边运行专项测试套件之前，请先检查其设置。

[黄金测试夹具](../tests/fixtures/golden-data/README.md)通过生产路径检验已保存的记录。在有意修改格式时，同步更新兼容性预期；不要为了让测试通过而手工编辑夹具内容。[独立的技能读取器测试](../tests/skills/README.md)单独使用 Python 运行，不需要应用运行时。

其他运行时检查关卡有前置条件：

| 检查 | 前置条件 / 用途 |
| --- | --- |
| `node scripts/smoke-provider-runtime.mjs` | 全新构建；使用测试夹具检验经过追踪的服务商负载/运行时路径。打包期间也会用到。 |
| `node scripts/smoke-web-subscriptions.mjs` | 已构建，且没有运行开发服务器；隔离的合成连接检查，外部流量被阻断。会短暂修改并恢复某个源文件的 mtime 以检验重新加载。 |
| `node scripts/build-plugin-types.mjs` | 在 `dist/plugin-sdk` 下构建可移植的、仅含类型的插件 SDK。 |
| `node scripts/build-server.mjs` 然后 `node scripts/smoke-server.mjs --isolated --browser` | 全新构建；组装/验证一份不含源码的独立副本、已安装的插件后端以及浏览器界面。加上 `--electron` 可使用 Electron 自带的 Node；浏览器检查需要本地的 Chrome/Chromium。 |
| 其他 `scripts/smoke-*.mjs` | 独立/原生渲染器、图像工作器、互动演示助手、压缩、文件路径、打开操作。运行之前请阅读每个脚本以及[发布指南](desktop-release.md)。 |

按变更的规模运行相应的检查。离线检查关卡证明的是被检验到的契约，而不是真实账号的权益或由模型编写的课程质量。
