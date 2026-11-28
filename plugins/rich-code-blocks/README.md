# 富代码块

一个可选的 LearnHarness 核心插件，只使用公开的插件 API。它把更高层次的记谱/标记语言转换为 **静态 SVG**：

| 初始关闭的设置 | 围栏标识 | 内容 |
| --- | --- | --- |
| 化学结构 | `smiles` | 一个 SMILES 分子 |
| 乐谱 | `abc` | 一首完整的 ABC 曲子；没有音频 |
| 技术图表 | `tikz` | TikZ、CircuitikZ、tikz-cd 和 PGFPlots |

在 **设置 → 核心插件**（Settings → Core plugins）中启用该插件，然后在它专属的设置页面中只启用需要的类别。只有已启用的类别才会注册渲染器，并向摸底、老师和练习智能体（包括教学会话开始时的摸底阶段）添加简短的系统指令。停用某个类别会恢复为普通的可读代码块。提示词的变化只作用于之后的回合，不影响已经在运行的模型请求。没有子领域开关、按类别的提示词编辑器、模拟、交互式电路、播放、原始 SVG 输入或自定义绘图工具栏。

## 透明外观

渲染出的 SVG 没有插件背景：对话记录会透出来。在全部三个类别中，中性的文字和线条都跟随应用的 **文字**（Text）颜色（`--foreground`），包括对文字颜色的覆盖。这也包括化学渲染器中中性的碳/氢墨迹。没有单独的墨迹颜色设置。带颜色的原子和显式着色的图表元素保持其颜色。有意设置的白色填充、作者编写的渐变/图案以及功能性的遮罩都会被保留，而不会被一概擦除或反色。在 TikZ 图表内部有意绘制的背景仍然是该图表的一部分；插件不会去猜测应该删除哪些形状。不使用混合模式或反色滤镜。

主题和文字颜色的变化会通过继承的 CSS 变量立即作用于已挂载的 SVG，无需替换它们、重新编译 TeX、清空已编译 SVG 的缓存或发送插件设置请求。新的缓存挂载同样会继承当前的文字颜色。已有的 v1 设置无论是否带有已废弃的 `inkColor` 键都仍然可读；其值会被忽略。启动时绝不会重写该文件。下一次更改类别开关时，会在保存设置时去掉这个已废弃的键，同时保留其他类别的选择。

## TikZ 尺寸

TikZ 图表会整体缩放，使引擎常规的 10 磅标签与周围对话中 LaTeX 的大小一致（`1.21em`，与 KaTeX 相同）。在默认 16 px 的阅读字号下，常规标签约为 **19.4 px**。相对于文字的 SVG 宽度会跟随周围字号的变化，而无需替换 SVG 或重新编译 TeX。作者编写的相对字号（包括下标）、图表比例以及原始的紧凑 viewBox 都会被保留。较宽的 TikZ 图表会在自己的包装容器内水平滚动，而不会缩小其标签。包装容器使用 **12 px 内边距** 并居中，没有额外的外边距或空白绘图区域。化学结构和乐谱使用自然尺寸并适应宽度。

## 核心插件与源码参考

应用负责提供并更新本插件的代码；可写的偏好设置位于 `<learning data>/core-plugin-data/rich-code-blocks/` 下。这个源码项目是参考材料，而不是可安装的社区插件副本。`rich-code-blocks` 是保留的核心插件 ID，即使被停用或缺失也是如此。社区分支需要自己的清单/文件夹 ID，并且必须重新考虑可能冲突的贡献项、工具和围栏代码块名称，包括 `smiles`、`abc` 和 `tikz`。新的插件 ID 并不能让重复注册的围栏代码块共存。不要把此构建安装到社区插件的 `plugins/rich-code-blocks/` 文件夹中。

## 开发

在解压后的编写工具包中，请在 **准备依赖之前**，把共享的 **工具包根目录下 `types/` 的内容** 复制到 `.sdk/` 中。在 `plugins/rich-code-blocks/` 下运行：

```sh
mkdir -p .sdk
cp -R ../../types/. .sdk/
```

如果是在相匹配的 LearnHarness 源码检出中，则改用 `npm run sdk`，它会使用 `../../scripts/build-plugin-types.mjs` 生成 `.sdk/`。该命令 **仅限仓库检出**，在解压后的工具包中无法使用。从 SDK 的导入只包含类型；运行时代码不会导入宿主的实现模块。

请单独准备开发依赖，包括 SDK 声明的 peer 依赖/类型。在依赖已就绪的情况下，仅构建的命令是：

```sh
npm run build
```

构建输出直接写入本项目的 **`dist/`**，而不是 `dist/<id>/`。它会打包 JavaScript 和本地的 TeX/WASM/字体，并复制许可证声明。清理会拒绝符号链接形式的 `dist/` 和放错位置的 `dist/data/`，并保留同级的 `data/`。构建不会安装、启用或更新核心插件，不会构建/重启宿主，也不会启用任何记谱类别。

## 示例

化学结构：

````markdown
```smiles
CC(=O)Oc1ccccc1C(=O)O
```
````

乐谱：

````markdown
```abc
X:1
T:Scale
M:4/4
L:1/4
K:C
C D E F | G A B c |]
```
````

物理/受力分析图和几何图形使用通用的 TikZ：

````markdown
```tikz
\usepackage{tikz}
\begin{document}
\begin{tikzpicture}
  \draw (0,0) rectangle (1,1);
  \draw[->] (0.5,0.5) -- (0.5,2) node[above] {$N$};
  \draw[->] (0.5,0.5) -- (0.5,-1) node[below] {$mg$};
\end{tikzpicture}
\end{document}
```
````

电路原理图（静态绘图，**不是电路仿真**）：

````markdown
```tikz
\usepackage{circuitikz}
\begin{document}
\begin{circuitikz}
  \draw (0,0) to[R=$R$] (3,0);
\end{circuitikz}
\end{document}
```
````

交换图：

````markdown
```tikz
\usepackage{tikz-cd}
\begin{document}
\begin{tikzcd}
  A \arrow[r,"f"] & B
\end{tikzcd}
\end{document}
```
````

解析函数图像：

````markdown
```tikz
\usepackage{pgfplots}
\pgfplotsset{compat=1.16}
\begin{document}
\begin{tikzpicture}
\begin{axis}[xlabel={$x$},ylabel={$f(x)$}]
  \addplot[domain=-2:2,samples=25]{x^2};
\end{axis}
\end{tikzpicture}
\end{document}
```
````

捆绑的引擎提供 standalone 文档类；不要添加 `\documentclass` 或 `\documentstyle`。每个代码块都必须自包含：在 `\begin{document}` 之前显式加载所需的宏包和 TikZ 库，最后以 `\end{document}` 结束。捆绑的宏包是可用的，但不会被自动加载；在另一个代码块中的声明不会延续过来。特别是，使用 `\text{...}` 的数学标签或对齐的方程需要加载 `\usepackage{amsmath}`。把图表环境直接放在 `document` 内，外面不要再套 `\[...\]`、`$$...$$` 或 `equation`。TikZ 节点标签可以使用 `$...$`；`tikzcd` 的单元格本身已处于数学模式。捆绑的 PGFPlots 版本为 **1.16**：请使用 `\pgfplotsset{compat=1.16}`，而不是 `compat=1.18` 或更新的版本。启用技术图表时，这些要求也会包含在摸底/老师/练习智能体的系统指令中。上游还包含配套的数学/数组/3D/chemfig 宏包，但它们并不是额外宣传的类别。本插件不提供原始 SVG/HTML/JS、shell、远程资源、上传数据文件或音频输入的途径。

## 渲染兼容性与错误

渲染器会为每个完整的 TikZ 代码块制作一份仅用于编译的副本。在字面的导言区中，它会移除多余的顶层 `\documentclass` 和 `\documentstyle` 声明（固定的 standalone 包装仍然掌管版面），并在 `\begin{document}` 之前紧接着提供 `amsmath`。在作者编写的宏包之后加载它，可以保留显式的宏包选项。文档类/样式选项不会被应用；它们不会选择另一个文档类。注释、分组的命令和文档内容不会被删除。会改变记号的 TeX 原语不会被展开，也不会被猜测。其他宏包/库仍需要声明。

原始代码块、已保存的对话历史和模型指令保持不变。没有模型修复请求或重试循环。真正的编译失败会显示一段有长度上限的纯文本 TeX 诊断，并在可用时在宿主的可读源码回退内容旁边显示对应的原始源码行。完整的 TeX 输出记录和源码转储不会写入持久化日志。诊断消息限制为 **2 KiB UTF-8**；常规的 Worker 期限和输出检查仍然适用。

## 生命周期、限制与安全

- 不完整和待完成的围栏代码块只显示源码，不会编译不完整的输入。错误和超出限制的情况使用宿主的“错误加可读源码”回退方案。
- TeX 在每个窗口中一个惰性、串行的浏览器 Worker 内运行。每个任务有 **10 秒** 的期限（包括冷启动加载），超时后 Worker 会被终止。活跃挂载的取消也会终止它；等待中被取消的任务会被移除。后续的任务会重新创建它。停用技术图表/插件会销毁它。
- 源码限制为 **SMILES 2 KiB / ABC 16 KiB / TikZ 32 KiB**，按 UTF-8 计算。生成的 SVG 上限为 **2 MiB**；TeX 最多允许 **16 个等待中的任务**。一个易失的 LRU 缓存最多保存 **32 个成功输出 / 8 MiB**（包括键）。没有持久化的渲染缓存或模型推理请求。
- TeX 固定的 WASM 线性内存约为 **69 MiB**。这并不是 Worker 内存总量的上限：JS 转换、解压后的资源和字体还会使用额外的内存。TeX 的 CPU 工作不会冻结页面的事件循环，但浏览器仍会消耗 CPU/内存。SMILES 和 ABC 在主线程上使用基于 DOM 的渲染器，并有源码上限；**并不声称它们有硬性的执行期限**。
- 所有的 JS、TeX/WASM、宏包资源和字体都是本地捆绑的资源，按需惰性加载。不使用 CDN、外部服务或由文档任意选择的 URL。
- 生成的 SVG 会在不激活或执行任何内容的情况下解析，然后用经过审核的静态元素和属性 **重新构建**。脚本、事件属性、HTML、链接、动画、外部 URL、样式表规则和不安全的 CSS 都会被丢弃。ID/本地引用会按每个挂载加上命名空间。循环的本地 `use` 引用会被拒绝；带记忆化的图统计会在挂载之前对 **use 展开后的输出同样施加 2 MiB 限制**，以防止体积很小、无环的引用放大载荷。文字/字体/样式的准入受到限制；只会选用捆绑的 TeX 字体或普通的系统字体族。绝不插入原始的模型 HTML。
- 渲染出的绘图是透明的，带有继承自主题的中性墨迹，并保持宽高比。化学结构/乐谱适应可用宽度；较宽的 TikZ 会滚动，以保持与数学公式同等大小的标签。插件自有的绘制变量只会在净化之后、最终的展开输出预算检查之前应用。遮罩亮度和有意设置的颜色/填充都会保留。不会挂载原始的生成树或交互监听器。中止/销毁会屏蔽迟到的结果。
- 设置带有版本号、经过校验，并以原子方式写入插件自有的 `data/settings.json`。只有被更改的类别开关会发送到后端；其他窗口同时进行的无关更改会被保留。被接受的修订版本会实时同步，重新连接时的读取无法覆盖较新的已接受修订版本。格式错误/版本更新的设置会显式地失败，而不会重写文件。停用绝不会删除它。

这仍然是受信任的本地插件代码，而不是用于运行任意第三方插件的沙箱。静态输出净化和隔离的 TeX Worker 并不授权任意 JS 执行，也不会削弱 Electron/宿主的隔离。

## 测试与边界

完成 SDK/依赖准备之后，以下检查使用插件项目，而不是宿主检出：

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
```

单元测试覆盖契约、设置、生命周期、缓存和 Worker 的边界，包括输出清理保护。浏览器脚本需要本地的 Chrome/Chromium（`CHROME_PATH` 或受支持的默认路径）、已构建的 `dist/` 文件以及项目的测试依赖。它会启动一个一次性的回环测试夹具和临时的 Chrome 配置文件，以测试真实的库、SVG 准入、超时/取消、字体尺寸、实时/缓存的主题变化、作者设置的颜色以及栅格化后的遮罩 alpha。一个仅用于开发的 KaTeX 依赖提供参考数学公式；它的代码/字体不会随插件构建一起发布。

该测试夹具模拟宿主；它不会启动/重启 LearnHarness，不会安装到真实的数据目录，不会调用模型，也不能证明打包应用/用户功能层面的验收。本项目没有 `test:native` 脚本。真实应用的集成和特定平台的行为需要单独的宿主检查。

## 源码阅读路线

- [`src/main.ts`](src/main.ts) 和 [`src/backend.ts`](src/backend.ts)：设置同步、有条件的围栏代码块注册以及附加的智能体指令。
- [`src/contract.ts`](src/contract.ts)：类别策略、源码/输出/缓存限制以及经过校验的设置。
- [`src/render.ts`](src/render.ts) → [`src/tex-runner.ts`](src/tex-runner.ts) → [`src/tex-worker.ts`](src/tex-worker.ts)：惰性渲染、串行工作、取消以及 Worker 生命周期。
- [`src/svg.ts`](src/svg.ts) 和 [`src/appearance.ts`](src/appearance.ts)：静态 SVG 准入、本地引用处理以及感知主题的绘制/尺寸。
- [`scripts/build.mjs`](scripts/build.mjs)、[`licenses/`](licenses/) 和 [`tests/`](tests/)：本地资源、上游改编、声明和测试夹具。

参见[示例地图](../../docs/plugin-examples.md)、[编写指南](../../docs/plugin-authoring.md)和 [API 参考](../../docs/plugin-api/README.md)。

## 许可证

AGPL-3.0-only。参见 [`LICENSE`](LICENSE)、[`THIRD-PARTY.md`](THIRD-PARTY.md) 和 [`licenses/`](licenses/)，了解固定版本的库、静态浏览器改编以及上游的许可证/声明。构建会保留完整的 GPLv3 和 Apache-2.0 文本，以及相关的 PyDvi/ColorBrewer 声明和其他上游许可证。
