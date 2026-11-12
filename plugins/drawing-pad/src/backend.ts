import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginBackendContext } from "learnharness-plugin-api";
import { DEFAULT_SETTINGS, parseColorChange, parseImageScaleChange, parseSettings, type Settings } from "./settings.ts";
import { acceptedPoseKeys } from "./poses.ts";

/** The backend stores preferences only. Editable drawings never leave window memory. */
export function activate(ctx: PluginBackendContext): () => void {
  const file = path.join(ctx.dataDirectory, "settings.json");
  let settings: Settings;
  try { settings = parseSettings(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    settings = { ...DEFAULT_SETTINGS };
  }
  let disposed = false;
  const assertActive = () => {
    if (disposed || ctx.signal.aborted) throw new Error("Drawing Pad is disabled.");
  };
  const get = ctx.handle("get-settings", () => { assertActive(); return { ...settings }; });
  const poses = ctx.handle("get-session-poses", input => {
    assertActive();
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 ||
      !("sessionId" in input) || typeof input.sessionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.sessionId))
      throw new Error("Expected a valid sessionId.");
    const record = ctx.learning.getSession(input.sessionId);
    return { sessionId: input.sessionId, poses: record?.kind === "practice" ? acceptedPoseKeys(record.messages) : [] };
  });
  const persist = (change: Partial<Pick<Settings, "darkInkColor" | "lightInkColor" | "imageScale">>) => {
    assertActive();
    const next = { ...settings, ...change, revision: settings.revision + 1 };
    if (next.darkInkColor === settings.darkInkColor && next.lightInkColor === settings.lightInkColor &&
      next.imageScale === settings.imageScale) return { ...settings };
    if (settings.revision === Number.MAX_SAFE_INTEGER) throw new Error("Settings revision limit reached.");
    fs.mkdirSync(ctx.dataDirectory, { recursive: true });
    const temporary = path.join(ctx.dataDirectory, `.settings-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(next) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    settings = next;
    ctx.events.emit("settings-changed", { ...settings });
    return { ...settings };
  };
  const set = ctx.handle("set-ink-color", input => { assertActive(); return persist(parseColorChange(input)); });
  const scale = ctx.handle("set-image-scale", input => { assertActive(); return persist({ imageScale: parseImageScaleChange(input) }); });
  return () => {
    if (disposed) return;
    disposed = true;
    get(); set(); scale(); poses();
  };
}
