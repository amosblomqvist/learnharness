/**
 * English catalog = the source of truth for keys. fa.ts is typed against it
 * (`Record<MessageKey, string>`), so a key added here and missing there is a
 * typecheck error — a string can never ship in one language only.
 * `{name}` marks an interpolation slot.
 */
export const en = {
	// ── language / general
	"language.label": "Language",
	"language.hint": "Interface and teaching language",
	"general.title": "General",

	// ── settings dialog
	"settings.title": "Settings",
	"settings.close": "Close",
	"settings.closeAria": "Close settings",
	"settings.sectionsAria": "Settings sections",
	"settings.loading": "Loading settings…",
	"settings.loadFailed": "Settings could not be loaded — refresh to retry.",
	"settings.section.keys": "Providers",
	"settings.section.agent": "Agent",
	"settings.section.appearance": "Appearance",
	"settings.section.graph": "Graph",
	"settings.section.keyboard": "Keyboard",
	"settings.section.general": "General",
	"settings.keyboardHint": "Stored on this device",

	// ── appearance section
	"appearance.mode": "Mode",
	"appearance.comingSoon": "Coming soon",
	"appearance.dark": "Dark",
	"appearance.background": "Background",
	"appearance.readingFont": "Reading font",
	"appearance.readingFontSize": "Reading font size",
	"appearance.sessionSerif": "Session names in serif",
	"appearance.headingWeight": "Heading weight",
	"appearance.boldColor": "Bold color",
	"appearance.italicColor": "Italic color",
	"appearance.sameAsText": "Empty = same as text",
	"graph.extraction": "Extraction",
	"graph.extractionHint": "Off = the graph stops growing",
	"graph.rendering": "Graph rendering",
	"graph.renderingHint": "Off = home shows the chains view",
	"graph.chunkBudget": "Extraction chunk budget",

	// ── sidebar
	"sidebar.open": "Open sidebar",
	"sidebar.close": "Close sidebar",
	"sidebar.home": "Home",
	"sidebar.teaching": "Teaching",
	"sidebar.practice": "Practice",
	"sidebar.all": "All",
	"sidebar.newTeachingSr": "create a new teaching session",
	"sidebar.newPracticeSr": "create a new practice session",
	"sidebar.sessions": "Sessions",
	"sidebar.searchSessions": "Search sessions",
	"sidebar.searchPlaceholder": "Search…",
	"sidebar.loading": "Loading…",
	"sidebar.noMatch": "No sessions match.",
	"sidebar.noSessions": "No sessions yet.",
	"sidebar.settings": "Settings",
	"sidebar.rename": "Rename",
	"sidebar.renameAria": "Rename session",
	"sidebar.exportMd": "Export as Markdown…",
	"sidebar.delete": "Delete…",
	"sidebar.practiceSession": "Practice session",

	// ── session meta / time
	"time.justNow": "just now",
	"time.minutesAgo": "{n}m ago",
	"time.hoursAgo": "{n}h ago",
	"time.daysAgo": "{n}d ago",
	"session.compacting": "Compacting context · {when}",
	"session.waiting": "Waiting for input · {when}",
	"session.problemWaiting": "Problem waiting · {when}",
	"session.working": "Working…",

	// ── home / new session
	"home.setupModels": "Set up your models",
	"home.askLearn": "What do you want to learn?",
	"home.askPractice": "What do you want to practice?",
	"home.startSession": "Start session",
	"home.startToBegin": "Start a session to begin learning.",
	"home.attachHint": "Attach your material with the paperclip or drag and drop.",
	"home.chains": "Chains",
	"home.chainsHint": "Every reasoning chain",
	"home.importedNotes": "{n} imported notes",
	"home.importedNote": "1 imported note",
	"newSession.title": "New session",
	"newSession.titlePractice": "New practice session",
	"newSession.descTeach": "The teacher will open by probing what you already know.",
	"newSession.descPractice":
		"Pick nodes from your knowledge graph, describe what you want to practice, or bring your own problem.",

	// ── composer
	"composer.nextProblem": "Next problem",
	"composer.pickNodes": "Pick nodes",
	"composer.nodesSelected": "{n} nodes selected",
	"composer.nodeSelected": "1 node selected",
	"composer.clear": "Clear",
} as const;

export type MessageKey = keyof typeof en;
