/** Dialog chrome and standalone modal surfaces (delete, abort, setup, find, cheatsheet). */

export const DIALOGS: Readonly<Record<string, string>> = {
	"Choose your AI provider and paste its API key. You’ll pick your models next.": "选择你的 AI 服务商并粘贴 API 密钥，接下来挑选模型。",
	"Close setup": "关闭设置向导",
	"Delete session": "删除会话",
	"Delete session?": "删除会话？",
	"Esc to close": "按 Esc 关闭",
	"Keyboard shortcuts": "键盘快捷键",
	"Loading models…": "正在加载模型……",
	"Pick the model for each tier. All three are required before chats can start.": "为每个档位选择模型。三个档位都选好之后才能开始对话。",
	"Provider": "服务商",
	"This permanently removes the session — its messages, background jobs, and extraction records. Everything it added to the graph stays unless you check below. This cannot be undone.": "这会永久删除该会话——包括它的消息、后台任务和提取记录。除非勾选下方选项，否则它已添加到图谱的内容会保留。此操作无法撤销。",
	" The working turn stops too.": " 正在运行的一轮也会停止。",
};
