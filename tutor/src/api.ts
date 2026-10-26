// Types shared with the main process, and the bridge exposed by preload.ts.
export type Mode = "tutor" | "writer"
export type Lens = "learn" | "explain" | "paper" | "infra" | "socratic" | "review"
export type KeyName = "anthropic" | "xai" | "openai" | "brave"
export type Settings = {
  modelId: string
  mode: Mode
  lens: Lens
  workspace: string | null
  aboutMe: string
  ollamaUrl: string
  claudePath: string
  grokPath: string
  mcpJson: string
  ide: string
  hideFromScreenShare: boolean
  learnPath: string
  pinned: boolean
}
export type ModelOption = { id: string; label: string; provider: "claude-plan" | "grok-plan" | "anthropic" | "xai" | "openai" | "ollama"; group: string; ready: boolean; note?: string }
export type PlanItem = { content: string; status: "pending" | "in_progress" | "completed" }
export type Hunk = { oldStart: number; newStart: number; lines: string[] }
export type ChangeView = { id: string; path: string; rel: string; created: boolean; deleted: boolean; added: number; removed: number; hunks: Hunk[]; tool: string; at: number }
export type Shot = { jpeg: string; preview: string }
export type IdeView = { id: string; name: string; project: string | null; projects: string[] }
export type IdeStatus = { list: IdeView[]; active: IdeView | null; choice: string }
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; id?: string; name: string; detail: string; input?: string }
  | { type: "tool-done"; id?: string; name: string; ok: boolean; detail?: string; change?: { path: string; added: number; removed: number } }
  | { type: "plan"; items: PlanItem[] }
  | { type: "usage"; input: number; output: number }
  | { type: "notice"; text: string }
  | { type: "learned"; notes: string[] }
  | { type: "note"; note: NoteInfo }
  | { type: "error"; text: string }
  | { type: "done" }
  | { type: "ask"; ask: AskView }
  | { type: "ask-done"; id: string; answer?: AskAnswer; grade?: AskGrade; cancelled?: boolean; run?: RunResult; match?: boolean }
  | { type: "trace"; trace: TraceView }
  | { type: "project"; project: ProjectView }

// Learn lens cards: a graded quiz, or a question with no right answer.
export type ExerciseView = { title: string; kind: "write" | "fix" | "types" | "complete" | "refactor"; language: "python" | "typescript" | "javascript"; starter: string; hints: string[]; hasSolution: boolean; typeChecked: boolean }
export type AskView = { id: string; kind: "quiz" | "question" | "predict" | "exercise"; question: string; details?: string; options: { label: string; description?: string }[]; multi: boolean; code?: string; language?: "python" | "typescript" | "javascript"; exercise?: ExerciseView }
// Exercise results: hidden tests (and tsc for TypeScript) against the user's code.
export type TestRun = { ok: boolean; tests: { name: string; ok: boolean; message?: string }[]; typeErrors: { file: string; line: number; message: string }[]; loadError?: string; stdout: string; timedOut: boolean; ms: number }
// A project checkpoint, as the window sees it (later milestones' tests stay hidden).
export type NotesWhere = { root: string; vault: string | null; obsidian: boolean }
export type NoteInfo = { goalId: string; nodeId: string; title: string; stage: string; stageTitle: string; file: string; at: number; added?: boolean }
export type ProjectView = { id: string; title: string; language: string; dir: string; goalId?: string; nodeId?: string; current: number; milestones: { title: string; state: "done" | "open" | "locked" }[]; lastRun?: { ok: boolean; passed: number; total: number; typeErrors: number }; done?: number }
// Lab: a program's real output, and a step-by-step trace of a Python run.
export type RunResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; ms: number }
export type TraceFrame = { fn: string; line: number; locals: [string, string][] }
export type TraceStep = { event: "call" | "line" | "return" | "exception"; line: number; stack: TraceFrame[]; out: string; ret?: string }
export type TraceView = { id: string; code: string; title?: string; steps: TraceStep[]; stdout: string; error: string | null; truncated: boolean }
export type AskAnswer = { picked: number[]; dontKnow?: boolean; other?: string; text?: string; note?: string; sure?: boolean; code?: string; hintsUsed?: number; gaveUp?: boolean; passed?: boolean }
export type AskGrade = { correct: boolean; correctIdx: number[]; explanation: string }
// late: answered after its turn had ended (the answer went to Tutor as a message).
export type Ask = AskView & { answer?: AskAnswer; grade?: AskGrade; cancelled?: boolean; late?: boolean; run?: RunResult; match?: boolean }
export type LearnStatus = { path: string; installed: boolean; files: { teach: boolean; visualize: boolean; researcher: boolean }; commit: string | null; date: string | null; edited: boolean }

// A turn in the order it happened: text, tool steps and cards interleaved.
export type Block = { t: "text"; text: string } | { t: "tool"; i: number } | { t: "ask"; id: string } | { t: "trace"; id: string } | { t: "project"; id: string }

export type Tool = { id?: string; name: string; detail: string; input?: string; ok?: boolean; result?: string; change?: { path: string; added: number; removed: number } }
export type Msg = {
  role: "user" | "assistant"
  text: string
  previews?: string[]
  tools: Tool[]
  notices: string[]
  learned?: string[]
  note?: NoteInfo // the recap this turn saved to the goal's notes
  plan?: PlanItem[]
  usage?: { input: number; output: number }
  error?: string
  by?: string
  flow?: Block[] // newer messages; older saved ones only have text + tools
  asks?: Ask[]
  traces?: TraceView[]
  projects?: ProjectView[]
}
export type ConvLink = { goalId?: string; nodeId?: string; review?: boolean }
export type ConversationSummary = ConvLink & { id: string; title: string; mode: Mode; updatedAt: number; count: number }

// Goals: a strategy drawn as a dependency map (electron/goals.ts).
export type NodeStatus = "todo" | "learning" | "solid" | "known"
export type NodeKind = "truth" | "concept" | "skill" | "project"
export type StrategyNode = { id: string; title: string; kind: NodeKind; stage: string; summary: string; why?: string; requires: string[]; check?: string; minutes?: number; resources?: { title: string; url: string }[]; status: NodeStatus; note?: string; optional?: boolean }
export type Stage = { id: string; title: string; outcome: string }
export type Strategy = { summary: string; approach: string; stages: Stage[]; nodes: StrategyNode[]; updatedAt: number }
export type Goal = { id: string; title: string; ask: string; createdAt: number; updatedAt: number; conversationId: string; courseId?: string; strategy: Strategy | null; sources: { id: string; kind: "video" | "page"; title: string; url: string; channel?: string; duration?: number }[]; lessons: { conversationId: string; nodeId: string; at: number }[]; notes?: Record<string, { file: string; at: number }> }
export type PhaseInfo = { id: number; title: string; note: string }
export type CourseInfo = { id: string; phase: number; step: number; realHours: number; after: { step: number; title: string }[]; title: string; blurb: string; hours: number; stages: number; nodes: number; started: { goalId: string; done: number; total: number } | null }
export type GoalSummary = { id: string; title: string; courseId?: string; updatedAt: number; total: number; done: number; drafting: boolean; next: { id: string; title: string; status: NodeStatus } | null }
// Code sent over from the IDE's "Ask Tutor" action.
export type IdeContext = { file: string; rel: string; start: number; end: number; code: string; lang: string; selected: boolean }

type Api = {
  getSettings(): Promise<{ settings: Settings; keys: Record<KeyName, boolean> }>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  setKey(name: KeyName, value: string): Promise<Record<KeyName, boolean>>
  listModels(): Promise<ModelOption[]>
  pickWorkspace(): Promise<Settings>
  capture(): Promise<Shot>
  send(input: { text: string; images: string[]; apply?: boolean; conversationId?: string } & ConvLink): Promise<void>
  answerAsk(id: string, answer: AskAnswer): Promise<{ ok: true; grade: AskGrade | null } | { ok: false }>
  learnStatus(): Promise<LearnStatus>
  installLearn(): Promise<LearnStatus>
  openLearnFolder(): Promise<string>
  pickLearnFolder(): Promise<LearnStatus>
  stop(conv?: string): Promise<void>
  reset(conv: string): Promise<void>
  hide(): Promise<void>
  openFarm(): Promise<{ ok: true } | { ok: false; error: string }>
  setPinned(on: boolean): Promise<void>
  ideStatus(fresh?: boolean): Promise<IdeStatus>
  getProfile(): Promise<string>
  setProfile(text: string): Promise<void>
  listConversations(): Promise<ConversationSummary[]>
  saveConversation(id: string, messages: Msg[], link?: ConvLink): Promise<ConversationSummary>
  openConversation(id: string): Promise<({ id: string; messages: Msg[] } & ConvLink) | null>
  listGoals(): Promise<GoalSummary[]>
  getGoal(id: string): Promise<Goal | null>
  createGoal(ask: string): Promise<Goal>
  listCourses(): Promise<CourseInfo[]>
  listPhases(): Promise<PhaseInfo[]>
  runExercise(id: string, code: string): Promise<TestRun | null>
  exerciseSolution(id: string): Promise<string | null>
  projectForNode(goalId: string, nodeId: string): Promise<ProjectView | null>
  openProject(id: string): Promise<string>
  listNotes(goalId: string): Promise<NoteInfo[]>
  readNote(goalId: string, nodeId: string): Promise<string | null>
  openNotes(goalId: string, file?: string): Promise<void>
  openInObsidian(goalId: string, file?: string): Promise<boolean>
  notesWhere(): Promise<NotesWhere>
  pickNotesFolder(): Promise<NotesWhere>
  resetNotesFolder(): Promise<NotesWhere>
  goalFromCourse(id: string): Promise<Goal>
  courseNews(goalId: string): Promise<{ count: number; titles: string[] } | null>
  takeCourseUpdate(goalId: string): Promise<Goal>
  deleteGoal(id: string): Promise<void>
  renameGoal(id: string, title: string): Promise<Goal | null>
  setNodeStatus(goalId: string, nodeId: string, status: NodeStatus): Promise<Goal | null>
  ideActionStatus(): Promise<{ binary: string | null; ides: { name: string; installed: boolean }[] }>
  installIdeAction(): Promise<{ binary: string | null; ides: { name: string; installed: boolean }[] }>
  ideAgentStatus(): Promise<{ installed: boolean; file: string; ready: boolean }>
  installIdeAgent(): Promise<{ installed: boolean; file: string; ready: boolean }>
  onConversationsChanged(cb: () => void): () => void
  deleteConversation(id: string): Promise<void>
  listChanges(): Promise<ChangeView[]>
  keepChanges(ids?: string[]): Promise<ChangeView[]>
  undoChanges(ids?: string[], force?: boolean): Promise<{ list: ChangeView[]; conflicts: string[] }>
  setWide(wide: boolean, big?: boolean): Promise<void>
  openInIde(file: string, line: number): Promise<{ ok: boolean; ide?: string }>
  onEvent(cb: (e: ChatEvent) => void): () => void
  onScreenshot(cb: (s: Shot) => void): () => void
  onMenu(cb: (action: string) => void): () => void
  onChanges(cb: (list: ChangeView[]) => void): () => void
  onPinned(cb: (on: boolean) => void): () => void
  onGoal(cb: (g: Goal) => void): () => void
  onReviews(cb: (stats: unknown) => void): () => void
  getReviews(): Promise<import("./ui/Today").ReviewInfo>
  onIdeContext(cb: (c: IdeContext) => void): () => void
  onFarmAsk(cb: (a: { text: string; shown: string }) => void): () => void
}

declare global {
  interface Window {
    tutor: Api
  }
}

export const api = window.tutor
