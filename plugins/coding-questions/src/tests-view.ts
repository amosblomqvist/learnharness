import type { CodingTests } from "./test-result.ts";

/** Display-only quoting; the runner passes argv literally and never uses a shell. */
function displayArgument(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function commandLine(tests: Pick<CodingTests, "program" | "args">): string {
  return [tests.program, ...tests.args].map(displayArgument).join(" ");
}

export interface TestApproval {
  approved(): boolean;
  setActive(active: boolean): void;
  dispose(): void;
}

/** The exact recipe the learner must approve before Submit is enabled. */
export function mountTestApproval(container: HTMLElement, tests: CodingTests, active: boolean, onChange: () => void): TestApproval {
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-coding-tests";
  const heading = document.createElement("div");
  heading.className = "lh-coding-tests__heading";
  heading.textContent = "Tests that will run on this computer";
  const command = document.createElement("pre");
  command.className = "lh-coding-tests__command";
  const prompt = document.createElement("span");
  prompt.setAttribute("aria-hidden", "true");
  prompt.textContent = "$ ";
  const commandText = document.createElement("code");
  commandText.textContent = commandLine(tests);
  command.append(prompt, commandText);
  const code = document.createElement("pre");
  code.className = "lh-coding-tests__code";
  code.tabIndex = 0;
  code.setAttribute("aria-label", "Test code");
  code.textContent = tests.code;
  const label = document.createElement("label");
  label.className = "lh-coding-tests__approval";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.disabled = !active;
  label.append(checkbox, " Run these tests on my computer when I submit");
  root.append(heading, command, code, label);
  container.append(root);
  const changed = () => { onChange(); };
  checkbox.addEventListener("change", changed);
  return {
    approved: () => checkbox.checked,
    setActive(next) { checkbox.disabled = !next; },
    dispose() {
      checkbox.removeEventListener("change", changed);
      root.remove();
    },
  };
}
