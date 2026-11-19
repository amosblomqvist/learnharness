<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>面向学习的智能体框架。</strong></p>

<p align="center">
  <a href="https://learnharness.ai">下载</a> ·
  <a href="#工作原理">工作原理</a> ·
  <a href="docs/README.zh-CN.md">文档</a> ·
  <a href="https://github.com/amosblomqvist/learnharness/issues">问题反馈</a> ·
  <a href="https://discord.gg/5tCHHQEB2e">Discord</a>
</p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

LearnHarness 用 AI 智能体，从你当前的理解出发，规划并讲授通往你目标的课程。它会细致地描绘你理解了什么、如何推理，并随着你的学习不断更新这张图景。

它不只是给你一段解释，而是用你的回答和思路判断你下一步需要什么。教学一步一个推理地搭建理解，练习让它变得可用，而一张持久的知识图谱把这一切带到下一次会话。

![LearnHarness 教学会话](docs/assets/teaching-session.png)

## 工作原理

1. **测量。** 在开讲之前，智能体会先找出你在本课依赖的每个部分上理解到什么程度。你的回答、置信度和思路会告诉它从哪里开始。
2. **规划。** 它从那个起点推导出一张通往目标的依赖图。你能看到这份计划；当你的理解与预期不同，课程会随之调整。
3. **讲授。** 每一步都建立在你已经理解的内容之上。你先预测，再听解释，然后检查自己的理解。任何混淆都会在被继续搭建之前修复。目标是让你的目标显得显然成立，而不只是眼熟。
4. **练习。** 另开的练习会话会给出不同的问题，要求你在问题不点名的情况下自己想到正确的知识。题目和提示会跟随你的推理调整。

**说出你的想法。** 思考输入框让你用自己的话说明推理、疑惑和反应。智能体正是借此得到细致的图景，而不只是答对答错的记录。你可以打字，也可以听写。

**带上你的材料。** 在桌面应用中，用回形针附加 PDF、照片或其他文件，也可以直接拖进来。文件留在原处：消息只携带它的路径，智能体从那里读取。

智能体还可以在后台研究问题、制作可视化解释、在课程中展示你自己的图片并用箭头和标注标出重点，以及构建交互式演示。

## 会跟随你的知识

你所学的内容会积累为命题和推理链条：单个主张，以及引出它们的诸前提。图谱展示这一结构，并链接回来源会话。你也可以导入笔记。

后续教学会话可以读取图谱，而不必从头开始；练习会话也能从中取材。它存储的是想法及其联系，而不是对你能力的评分。

![LearnHarness 知识图谱](docs/assets/knowledge-graph.png)

## 下载与开始

**[从 learnharness.ai 下载](https://learnharness.ai)** · [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases)

- **macOS（Apple Silicon）：** 已签名并公证的 DMG。把应用拖入「应用程序」。
- **Windows（x64）：** 运行安装程序。目前未签名，Windows 可能显示「未知发布者」或 SmartScreen 提示。
- **Linux（x64）：** 让 AppImage 可执行后打开，或安装 Debian/Ubuntu 的 `.deb`。

选择你的模型，然后用你想理解的内容开始一个会话。你可以使用服务商的 API 密钥、桌面应用中支持的订阅连接、已安装的 [Claude Code CLI](docs/claude-code.md)，或[自定义 OpenAI 兼容端点](docs/custom-providers.md)（包括本地模型服务）。可选的听写和网页搜索使用单独的服务密钥。网页研究可在 设置 → 服务商 → 搜索 中使用 Tavily、Brave、Exa、Firecrawl 或 Ollama 密钥。Ollama 搜索使用其托管服务，而非本地模型服务。

模型设置、听写、文件和笔记导入见[快速开始](docs/getting-started.md)；缓存偏好等进阶内容见[上下文、缓存与费用](docs/compaction-accounting.md)。

三个平台都支持应用内更新。

## 你的密钥，你的数据

- **你的密钥和模型。** 没有 LearnHarness 订阅，也没有加价。计费取决于你的服务商、CLI 配置、订阅或本地部署。实时费用表估算已知的 API 费用，不含订阅、CLI 或自定义端点费用。
- **本地存储。** 对话、图谱、设置和 API 密钥都保存在你的机器上。学习记录是你可以直接查看的纯文件。
- **外部服务。** 模型经由你配置的服务商运行。模型请求会发送完成任务所需的上下文；网页研究和听写也会联系外部服务。本地存储不等于离线处理。
- **可检查的行为。** 系统提示词可见且可编辑。应用以 AGPL-3.0 许可开源。

## 开发与支持

```bash
npm ci
npm run plugins:setup
npm run dev        # http://localhost:3000
npm test           # fixtures and fake providers
```

全部指南见[文档索引](docs/README.zh-CN.md)，环境搭建与检查见[开发](docs/development.md)，运行时架构见[架构](docs/architecture.md)，快捷键见[键盘](docs/keyboard.md)，主题文件格式见[主题](docs/themes.md)，桌面构建与发布见[桌面构建与发布](docs/desktop-release.md)。

可信的本地插件从[编写指南与能力地图](docs/plugin-authoring.md)开始，其中链接了问题、练习题、提交、视图上下文与 UI 契约。小型可运行模板见 [`examples/plugins/`](examples/plugins/)，功能源码见 [`plugins/`](plugins/)，内部机制见[宿主架构](docs/plugin-architecture.md)。

问题、缺陷报告和功能请求：[GitHub Issues](https://github.com/amosblomqvist/learnharness/issues)。

安全漏洞：请按 [SECURITY.md](SECURITY.md) 中的说明私下报告，不要发在公开 issue 中。

## 许可

[AGPL-3.0](LICENSE)

应用永久免费开源。若将来收费，也只会为便利付费——托管密钥、托管服务——绝不为你可在本地运行的功能收费。
