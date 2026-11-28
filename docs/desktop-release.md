# 桌面构建与发布

这是一份维护者参考文档。安装与日常使用请从[快速上手](getting-started.md)开始。

## 平台与前置条件

| 平台 | 发布运行器 | 安装包 | 应用内更新 |
| --- | --- | --- | --- |
| macOS，Apple Silicon | `macos-26` arm64 | 已签名/已公证的 DMG + ZIP | 通过 Squirrel.Mac 使用 ZIP |
| Windows，x64 | `windows-2025` | 未签名的按用户安装 NSIS 安装程序 | NSIS |
| Linux，x64 | `ubuntu-24.04` | AppImage + `.deb` | 替换 AppImage；`.deb` 通过 dpkg/apt 更新，必要时提权 |

Windows 可能显示 SmartScreen/未知发布者警告。AppImage 是 Linux 的主要下载包；`.deb` 更新可能需要管理员密码。两者使用同一个下载/重启横幅。目标平台/签名在 [`electron-builder.yml`](../electron-builder.yml) 中定义；CI/发布使用 **Node 26**。

macOS 图标编译 `build/icon.icon` 需要 **macOS 26+ 和 Xcode 26+**。`actool` 生成 `Assets.car`；`after-pack.cjs` 恢复全分辨率的回退 icns。Windows/Linux 使用由 `scripts/make-icons.mjs` 生成的扁平设计图标。Linux 桌面标识为 `learnharness.desktop`。

所有平台都保留自定义应用栏。macOS 在左侧显示红绿灯按钮/系统菜单；Windows/Linux 在右侧使用原生的 Window Controls Overlay，并通过 Alt 键显示原生菜单。

## 构建流水线

**在每个目标操作系统上分别构建**。Next 追踪的是构建机器上的原生二进制文件；macOS 的独立运行目录树不能用作 Windows/Linux 的负载。

1. `npm ci`
2. 在 Electron 的 Node 中运行原生渲染器/浏览器服务测试：
   ```sh
   ELECTRON_RUN_AS_NODE=1 NODE_ENV=test npx electron --import tsx --test tests/pdf-native-render.test.ts tests/pdf-ops.test.ts tests/svg-native-render.test.ts tests/browser-service.test.ts
   ```
   这种环境变量前缀语法适用于 POSIX shell；CI 在所有操作系统上都使用 Bash。
3. `npm run build`
4. `node scripts/smoke-provider-runtime.mjs`——检查**整理之前的全新追踪结果**，包括原生服务商初始化和测试夹具负载，而不是真实的登录/生成。
5. `node scripts/build-server.mjs`——复制静态资源、校验提示词资源、拒绝已知的数据/凭据泄漏，并且只删除独立运行根目录中的旧安装程序/开发用 Electron。
6. `node scripts/smoke-server.mjs --electron`——在 Electron 的 Node 下检查渲染器/互动演示的依赖、服务商、gzip 背压，以及隔离的独立 HTTP 启动。
7. 按下文相应的本地/发布策略，用 Electron Builder 打包。

外壳/更新器随 `app.asar` 一起发布；服务器/原生渲染器以未打包的 `extraResources` 形式发布。Pi/PDF/canvas/resvg/Photon 的动态资源在 [`next.config.ts`](../next.config.ts) 中显式追踪。追踪排除规则要尽量窄：宽泛的 `dist/**` 或 `data/**` 模式可能会删掉依赖的资源。整理阶段的防护措施不能代替对变更后负载的检查。

发布工作流还会在宿主 Node 和打包后的 Electron 下检查来自**打包后**负载的服务商，然后使用应用的 Electron（Linux 上使用 Xvfb）检验互动演示助手。仅凭 HTTP 启动或目录输出无法测试这些惰性路径。

`smoke-image-runtime.mjs` 单独检查独立运行输出中合成的 Photon 进程内/工作器图像缩放。它接受 `--standalone <dir>` 和 `--runtime <binary>`；它**目前未被 CI/发布工作流调用**。

### 本地打包

`npm run desktop:dist` 是本地的**已签名 macOS** 路径，使用 `LH_NOTARY` 钥匙串配置和 Xcode `DEVELOPER_DIR`。它会清空 `dist` 和 `.next/standalone`，然后构建、检查全新的服务商追踪结果、整理、在**宿主 Node** 下运行服务器冒烟测试，并打包。它本身不会运行 Electron-Node/打包后的检查关卡，也不会运行打标签上传的工作流。

对于 Windows/Linux，请在对应的操作系统上执行第 1–6 步，然后：

```sh
npx electron-builder --win --x64 --publish never    # Windows
npx electron-builder --linux --x64 --publish never # Linux
```

## CI 与发布模式

[CI](../.github/workflows/ci.yml) 在 Ubuntu 上运行类型检查/测试/lint，并在 macOS、Windows 和 Linux 上运行独立运行/原生检查。其中 `macos-15` 任务不编译发布用图标。

[桌面发布](../.github/workflows/release.yml)有两种模式：

- **手动触发**：未签名的预演安装程序作为工作流产物保留七天。不涉及签名密钥、不创建发布、不公开发布。跳过 macOS 公证；这些不是正式安装程序。
- **匹配的 `v<package.json version>` 标签**：检查关卡、一个共享的草稿准备任务、三个操作系统的打包/上传任务，然后是只读的草稿验证。已发布或有歧义的现有发布会导致准备阶段失败；同一 ref 的运行会串行执行，而不是取消上传。macOS 必须签名/公证。**工作流从不发布草稿。**

### 草稿验证

[`scripts/verify-release.ts`](../scripts/verify-release.ts) 在所有打包任务完成后运行。它要求恰好有一个通过 `v<version>` 或纯 `<version>` 匹配到的草稿，匹配到零个/两个或匹配到已发布的版本时都会拒绝。纯版本号匹配会发出警告，因为之后的运行可能会把资源分散到不同标签下。

草稿必须包含**恰好 11 个已上传的非空资源**：

| 资源 | 用途 |
| --- | --- |
| `LearnHarness-<v>-arm64.dmg` + `.blockmap` | macOS 安装程序 |
| `LearnHarness-<v>-arm64-mac.zip` + `.blockmap` | macOS 更新包 |
| `LearnHarness-<v>-x64-setup.exe` + `.blockmap` | Windows 安装程序/更新包 |
| `LearnHarness-<v>-x86_64.AppImage` | Linux AppImage |
| `LearnHarness-<v>-amd64.deb` | Debian 软件包 |
| `latest-mac.yml`、`latest.yml`、`latest-linux.yml` | 更新源 |

更新源中的版本、所引用资源的精确集合、纯文件名、大小以及旧式的路径/哈希字段必须一致；macOS 的 ZIP 必须排在第一位。缺失/过时的多余资源、路径穿越/URL，或构建工具的命名漂移都会导致校验失败。校验器不会下载每个安装程序并计算哈希；它检查的是草稿元数据和下载的更新源。

验证任务需要 `contents: write` 权限才能列出私有草稿，但只执行 GET 操作。它的 token 只暴露给发布列表/更新源下载，不暴露给依赖安装或离线校验。

### 签名密钥

仓库的 Actions 密钥：

| 密钥 | 用途 |
| --- | --- |
| `MAC_CSC_LINK` | Base64 编码的 Developer ID Application `.p12`，包含私钥 |
| `MAC_CSC_KEY_PASSWORD` | `.p12` 密码 |
| `APPLE_ID` | 用于公证的 Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | App 专用密码 |
| `APPLE_TEAM_ID` | Apple 开发者团队 ID |

工作流把证书映射到 `CSC_LINK`/`CSC_KEY_PASSWORD`；签名凭据只传给打包步骤，不传给 Next 构建。内置的 `GITHUB_TOKEN` 提供有作用域限制的 `GH_TOKEN`；不需要单独的发布 token。切勿提交密钥、证书、密码或环境机密文件。

## 发布操作手册

1. 商定范围/版本，并完成相关的检查关卡和人工功能验收。如果预演安装程序有用，就使用手动触发；未签名的预演不能证明 macOS 签名可用。
2. 更新 package/lockfile 中的版本，在 main 上确认预期的源码，然后推送经授权的匹配标签。在正式的 macOS 打包之前确认签名密钥。
3. 等待**所有操作系统任务以及 Verify draft release** 完成。检查唯一草稿的标签、说明、11 个资源和更新源。重试之前先诊断失败原因。重新上传会替换同名资源；过时的多余资源仍会导致失败。删除资源/发布属于变更操作，而不是验证。
4. 如需编辑草稿元数据，**每次元数据 PATCH 都要带上规范的 `tag_name: "v<version>"`**，即使只修改标题/正文；以前遗漏它曾导致标签被重置。之后重新读取标签、草稿状态和资源。修正标签并不意味着可以删除/重建发布。
5. 所有者按需检查打包后的构建，并明确发布完整的草稿。确认公开的安装程序/更新源和网站链接；用之前已安装的版本来检查真实的更新路径。

涉及外壳、原生模块、打包/更新器或 Electron 的修改，需要做针对性的平台检查：安装/打开、窗口控制/拖动/缩放、设置/恢复、PDF/SVG 以及互动演示助手。测试夹具检查关卡不能证明账号功能或课程质量。没有具体风险时，不要重复已验收的功能测试。

## 更新与网站通知

打包后的应用默认在启动时以及每 24 小时检查一次更新，自动下载，并在退出或点击**重启**（Restart）时安装。**设置 → 通用**（Settings → General）提供发行说明、手动检查、状态以及**自动更新**（Automatic updates）。关闭自动检查不会取消正在进行的下载/已暂存的安装；手动检查仍会下载更新。开发构建会禁用更新器。错误写入 `userData/logs/main.log`；`LH_UPDATE_FEED` 是仅用于测试的通用更新源覆盖。

源码：[`electron/main.cjs`](../electron/main.cjs)、[`preload.cjs`](../electron/preload.cjs)、[`update-settings.tsx`](../components/settings/update-settings.tsx)。

稳定版发布之后，[`notify-website.yml`](../.github/workflows/notify-website.yml) 会使用 `WEBSITE_DISPATCH_TOKEN` 把标签派发给网站。草稿/预发布版本不会触发它。HTTP 204 表示网站更新已进入队列，而不是已部署或已公开验证。
