import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { DEFAULT_SETTINGS, FAMILIES, INSTRUCTIONS, parseChange, parseSettings, type Settings } from "./contract.ts";

export function activate(ctx: PluginBackendContext): () => void {
  const file = path.join(ctx.dataDirectory, "settings.json");
  let settings: Settings;
  try { settings = parseSettings(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    settings = { ...DEFAULT_SETTINGS };
  }
  const instructionDisposers: (() => void)[] = [];
  const updateInstructions = () => {
    instructionDisposers.splice(0).forEach(dispose => dispose());
    for (const family of FAMILIES) if (settings[family]) {
      instructionDisposers.push(ctx.registerInstructions({ agents: ["teacher", "practice"], text: INSTRUCTIONS[family] }));
    }
  };
  const assertActive = () => { if (ctx.signal.aborted) throw new Error("Rich code blocks is disabled."); };
  updateInstructions();
  const unregisterGet = ctx.handle("get-settings", () => { assertActive(); return { ...settings }; });
  const nextRevision = () => {
    if (settings.revision === Number.MAX_SAFE_INTEGER) throw new Error("Settings revision limit reached.");
    return settings.revision + 1;
  };
  const commit = (next: Settings, instructionsChanged = false) => {
    fs.mkdirSync(ctx.dataDirectory, { recursive: true });
    const temporary = path.join(ctx.dataDirectory, `.settings-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    settings = next;
    if (instructionsChanged) updateInstructions();
    ctx.events.emit("settings-changed", { ...settings });
    return { ...settings };
  };
  const unregisterSave = ctx.handle("set-family", input => {
    assertActive();
    const { family, enabled } = parseChange(input);
    if (settings[family] === enabled) return { ...settings };
    return commit({ ...settings, revision: nextRevision(), [family]: enabled }, true);
  });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unregisterGet(); unregisterSave();
    instructionDisposers.splice(0).forEach(dispose => dispose());
  };
}
