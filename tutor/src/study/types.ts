// The study app's content model. Modules are premade Markdown files in content/, parsed by parse.ts.
// Nothing here calls a model: every check is run or compared locally.

export type Lang = "python" | "typescript" | "shell"
export type ConfigLang = "yaml" | "hcl" | "json" | "dockerfile"

export type Option = { text: string; right: boolean }
// Lab machines beyond the default container: a peer on the same network, or a VM with blank disks.
export type Machines = { peer?: string; peerSetup?: string; peerVerify?: string; fullvm?: boolean; disks?: string[] }
export type Check = { expr: string; message: string }

export type Step =
  // Pick one. Becomes a review card.
  | { kind: "quiz"; q: string; options: Option[]; why: string }
  // Read code, type what it prints. Becomes a review card.
  | { kind: "predict"; lang: Lang; q: string; code: string; answer: string; why: string }
  // Recall, then compare with the answer and say whether you had it. Becomes a review card.
  | { kind: "card"; q: string; answer: string }
  // Write code until the hidden tests pass.
  // wrong: answers the tests must reject (a hard-coded result, a common mistake), checked by check:study.
  // fail: marks HOW a wrong answer is meant to fail, which check:study enforces: "runtime" must
  // pass tsc (the tests catch it), "types" must be refused by tsc (TypeScript, the clerk).
  | { kind: "write"; lang: "python" | "typescript"; task: string; starter: string; tests: string; types?: string; solution: string; hint: string; wrong?: { why: string; code: string; fail?: "runtime" | "types" }[] }
  // Run shell commands in a throwaway folder with these files; stdout must match, or verify must pass.
  // With vm, they run as root on a fresh Ubuntu machine in the Linux lab (files go to /root); with
  // peer, a second machine of that name sits on the same network (peersetup/peerverify run there);
  // fullvm or disks make the machine a small VM with its own kernel and blank disks.
  | { kind: "shell"; task: string; files: Record<string, string>; setup?: string; expect?: string; verify?: string; solution: string; hint: string; git?: boolean; secret?: boolean; vm?: boolean } & Machines
  // A live root shell on a lab machine that stays up while the step is on screen; Check runs verify
  // against the state you left. The checker runs "scripted" (or the solution) on a fresh machine.
  | { kind: "term"; task: string; files: Record<string, string>; setup?: string; verify: string; solution: string; scripted?: string; hint: string } & Machines
  // An open-ended project built in a real folder on your Mac, in your own editor: the spec, the files
  // the folder starts with (often only a README), hidden acceptance tests (test_*.py) run against the
  // folder, and a reference solution (files) that check:study proves passes. local: the tests need the
  // project's own toolchain (uv, packages, network), so Check runs them outside the sandbox.
  | { kind: "project"; task: string; folder: string; files: Record<string, string>; tests: Record<string, string>; solution: Record<string, string>; hint: string; local?: boolean }
  // Write or fix a config file; every check must hold.
  | { kind: "config"; lang: ConfigLang; task: string; starter: string; checks: Check[]; solution: string; hint: string }

export type Lesson = {
  id: string
  module: string
  title: string
  stage: string
  needs: string[]
  minutes: number
  goal: string
  body: string
  steps: Step[]
  sources: { title: string; url: string }[]
  project: boolean
  // "show: play([\"go cellar\", \"take axe\"]) -> room-bag": the world card. After Run/Submit the
  // app evaluates the expression against your code and draws the room it returned.
  show?: { expr: string; kind: string }
}

export type Stage = { id: string; title: string; outcome: string }

export type Module = {
  id: string
  title: string
  blurb: string
  why: string
  stages: Stage[]
  lessons: Lesson[]
  // Its write steps come back as reviews to write again from a blank editor.
  rewrite: boolean
}

export const reviewable = (s: Step): s is Extract<Step, { kind: "quiz" | "predict" | "card" }> => s.kind === "quiz" || s.kind === "predict" || s.kind === "card"
