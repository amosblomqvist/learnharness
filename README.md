<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>为学习打造的智能体框架。</strong></p>

<p align="center">
  <a href="https://learnharness.ai">下载</a> ·
  <a href="#how-it-works">工作原理</a> ·
  <a href="docs/README.md">文档</a> ·
  <a href="https://github.com/amosblomqvist/learnharness/issues">Issues</a> ·
  <a href="https://discord.gg/5tCHHQEB2e">Discord</a>
</p>

LearnHarness 使用 AI 智能体，从你当前的理解出发，规划并讲授通往目标的课程。它会细致地描绘出你理解了什么、以及你如何推理，并在你学习的过程中不断更新这幅图景。

它不只是给你一段讲解，而是根据你的回答和思考来决定你下一步需要什么。教学一次推进一个推理步骤来建立理解；练习让理解变得可用；持久的知识图谱让它延续到之后的会话中。

![LearnHarness 教学会话](docs/assets/teaching-session.png)

<a id="how-it-works"></a>
## 工作原理

1. **摸底**。在教学之前，智能体会在课程所依赖的每个部分上找到你理解的边界。你的回答、把握度和思考会告诉它从哪里开始。
2. **规划**。它从这个起点到你的目标梳理出一张依赖关系图。你可以查看学习计划；当你的理解与预期不同时，课程会随之调整。
3. **教学**。每一步都建立在你已经理解的内容之上。你先预测，再获得讲解，然后检验自己的理解。困惑会在被用作后续基础之前得到纠正。目标是让结论显得理所当然，而不仅仅是似曾相识。
4. **练习**。独立的练习会话会给出多样的题目，要求你在没有事先被点明的情况下想到正确的知识。题目和提示会根据你的推理进行调整。

**说出你的思考**。思考栏让你用自己的话解释推理过程、不确定之处和第一反应。这样智能体得到的是一幅细致的图景，而不只是对错记录。你可以打字，也可以使用语音听写。

**带上你的文件**。在桌面应用中，可以通过回形针按钮附加 PDF、照片或任何其他文件，也可以直接拖入。文件保留在原处：消息中携带的是它的路径，智能体从那里读取它。

智能体还可以在后台调研问题、制作图示讲解、在课程中展示你自己的图片并用箭头和标注加以标记（包括直接从你的 PDF 中裁剪出的插图，例如课件幻灯片），以及构建互动演示。

## 延续下去的知识

你所学的内容会积累为命题和推理链：一条条独立的论断，以及推出它们的前提。图谱展示了这种结构，并链接回来源会话。你也可以导入笔记。

之后的教学会话可以读取图谱，而不必从零开始。练习会话可以从中选取素材。它存储的是观点及其相互联系，而不是对你能力的评分。

![LearnHarness 知识图谱](docs/assets/knowledge-graph.png)

## 下载与上手

**[从 learnharness.ai 下载](https://learnharness.ai)** · [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases)

- **macOS（Apple Silicon）**：已签名并经过公证的 DMG。将应用拖入“应用程序”（Applications）文件夹。
- **Windows（x64）**：运行安装程序。安装程序目前未签名；Windows 可能会显示“未知发布者”或 SmartScreen 警告。
- **Linux（x64）**：为 AppImage 添加可执行权限后打开，或安装适用于 Debian/Ubuntu 的 `.deb`。

选择你的模型，然后带着你想理解的内容开始一个会话。你可以使用服务商的 API 密钥、桌面应用中支持的订阅连接、已安装的 [Claude Code CLI](docs/claude-code.md)，或者[自定义的 OpenAI 兼容端点](docs/custom-providers.md)（包括本地模型服务器）。可选的语音听写和网页搜索使用单独的服务密钥。网页调研可以在 设置 → 服务商 → 搜索 中使用 Tavily、Brave、Exa、Firecrawl 或 Ollama 的密钥。Ollama 搜索使用的是其托管服务，而不是本地模型服务器。

模型设置、语音听写、文件和笔记导入请参阅[快速上手](docs/getting-started.md)；高级缓存偏好请参阅[上下文、缓存与费用](docs/compaction-accounting.md)。

三个平台都支持应用内更新。

## 你的密钥，你的数据

- **你自己的密钥和模型**。没有 LearnHarness 订阅，也没有加价。计费取决于你的服务商、CLI 配置、订阅或本地环境。实时费用计量器估算的是已知的 API 费用，不包括订阅、CLI 或自定义端点的费用。
- **本地存储**。你的聊天记录、图谱、设置和 API 密钥都保存在你的设备上。学习记录是可供你查看的普通文件。
- **外部服务**。模型通过你配置的服务商运行。模型请求会发送任务所需的上下文；网页调研和语音听写也会访问外部服务。本地存储并不意味着离线处理。
- **行为可审查**。系统提示词可见且可编辑。本应用以 AGPL-3.0 许可证开源。

## 开发与支持

```bash
npm ci
npm run plugins:setup
npm run dev        # http://localhost:3000
npm test           # fixtures and fake providers
```

所有指南见[文档索引](docs/README.md)；环境搭建与检查见[开发](docs/development.md)；运行时见[架构](docs/architecture.md)；另有[键盘快捷键](docs/keyboard.md)、主题文件格式见[主题](docs/themes.md)，以及[桌面构建与发布](docs/desktop-release.md)。

对于受信任的本地插件，请从[编写指南与能力图](docs/plugin-authoring.md)开始。它链接了问题、练习题目、提交、视图上下文和 UI 的契约。小型可运行模板请使用 [`examples/plugins/`](examples/plugins/)，功能源码项目见 [`plugins/`](plugins/)，内部实现见[宿主架构](docs/plugin-architecture.md)。

问题咨询、缺陷报告和功能请求：[GitHub Issues](https://github.com/amosblomqvist/learnharness/issues)。

安全漏洞：请按照 [SECURITY.md](SECURITY.md) 中的说明私下报告，不要提交到公开的 issue 中。

## 许可证

[AGPL-3.0](LICENSE)

本应用永久免费且开源。如果我们将来要为任何东西收费，那也只会是为了便利性—托管的密钥、托管服务—绝不会为你可以在本地运行的功能收费。
