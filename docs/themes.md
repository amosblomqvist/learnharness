# 主题

**设置 → 外观 → 主题**（Settings → Appearance → Theme）用于设置应用界面的配色。LearnHarness 内置十一个预设：默认（Default，即原有的深色配色）、Catppuccin Latte、Frappé、Macchiato 和 Mocha、Rosé Pine 和 Rosé Pine Dawn、Gruvbox Dark、Ivory、Pastel，以及 NvChad Onedark。每个主题都会声明自己是深色还是浅色。原生窗口背景跟随实际生效的背景色（包括你的覆盖设置）；原生控件符号会选择形成对比的颜色。Mermaid 图表跟随主题的浅色/深色模式。生成的插图保留其自身的颜色和现有的反色控制。使用应用 CSS 令牌的插件会继承这些颜色；插件特有的配色和图稿不会被改写。

## 覆盖单个颜色

主题网格下方的 **颜色**（Colors）区块为每种主题颜色提供一个字段。已填写的字段优先于当前主题；空字段则使用主题的值，该值显示在字段的提示中。切换主题时覆盖设置会被保留，因此你喜欢的背景色在更换配色后依然有效。**全部重置**（Reset all）会清除所有覆盖设置。

`background`、`bold` 和 `italic` 沿用它们在引入主题之前的设置键（`appearance.background`、`mdRendering.boldColor`、`mdRendering.italicColor`），因此在旧版本中设置的值仍然有效。

## 主题文件

**导出 JSON**（Export JSON）会下载应用了你的覆盖设置的当前主题。将该文件重新导入即可还原屏幕上的效果。**导入 JSON**（Import JSON）接受以下结构的文件：

```json
{
	"name": "My Theme",
	"mode": "dark",
	"colors": {
		"background": "#1e1e2e",
		"surface": "#313244",
		"border": "#45475a",
		"text": "#cdd6f4",
		"textMuted": "#a6adc8",
		"accent": "#cba6f7",
		"bold": "#b4befe",
		"italic": "#f5c2e7",
		"code": "#fab387",
		"error": "#f38ba8",
		"success": "#a6e3a1",
		"warning": "#f9e2af"
	}
}
```

十二种颜色全部必填，格式为 `#rgb` 或 `#rrggbb` 十六进制。`mode` 为 `"dark"` 或 `"light"`。缺少键或键值无效的文件会被拒绝，错误信息会指明是哪个键。

| 键 | 显示位置 |
|---|---|
| `background` | 页面背景 |
| `surface` | 卡片、弹出框、输入框；悬停状态由它派生 |
| `border` | 边框和输入框轮廓 |
| `text` | 正文文本 |
| `textMuted` | 次要文本和提示 |
| `accent` | 焦点环、开关、选中的主题卡片 |
| `bold` | 课程中的**粗体**文本 |
| `italic` | 课程中的*斜体*文本 |
| `code` | 课程中的行内 `code` |
| `error` | 错误、错误答案、破坏性操作 |
| `success` | 正确答案、已连接状态 |
| `warning` | 警告和部分完成状态 |

## 自定义主题的存放位置

导入的主题以 `<id>.json` 的形式保存在应用数据目录的 `themes/` 文件夹中（在开发检出中为 `data/themes/`，在桌面应用中则位于 Electron 的 `userData` 下）。id 是由名称生成的 slug；与现有主题重名时会加上 `-2`、`-3`… 后缀。预设的 id 是保留的。

删除当前使用的自定义主题会切换回“默认”主题，并保留你的覆盖设置。如果所选文件在应用之外被删除或变得无效，界面会回退到“默认”主题；下一次保存外观设置时也会修复已保存的选择，因此字体和其他外观设置仍然可以编辑。
