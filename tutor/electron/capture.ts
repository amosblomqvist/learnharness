// Screenshot of the display the cursor is on. The overlay hides itself first
// so it never ends up in its own screenshot. Images are scaled so the long edge
// is at most 1568px: sharper doesn't help the models, it only costs tokens.
import { desktopCapturer, screen, systemPreferences, type BrowserWindow } from "electron"

const MAX_EDGE = 1568

export async function captureScreen(win: BrowserWindow | null): Promise<{ jpeg: string; preview: string }> {
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    // Asking once makes macOS list the app under Privacy & Security → Screen Recording.
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {})
    throw new Error("Screen Recording permission needed: System Settings → Privacy & Security → Screen Recording → enable Tutor (or Electron in dev), then restart the app.")
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { width, height } = display.size
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
  const size = { width: Math.round(width * scale), height: Math.round(height * scale) }

  const wasVisible = !!win?.isVisible()
  if (wasVisible) win!.hide()
  await new Promise((r) => setTimeout(r, 180))
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size })
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!src || src.thumbnail.isEmpty()) throw new Error("Could not capture the screen.")
    const jpeg = src.thumbnail.toJPEG(82).toString("base64")
    const preview = src.thumbnail.resize({ width: 240 }).toDataURL()
    return { jpeg, preview }
  } finally {
    if (wasVisible) win!.showInactive()
  }
}
