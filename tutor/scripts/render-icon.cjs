// Renders assets/icon.svg to assets/icon.png (1024², transparent corners).
// Run: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require("electron")
const fs = require("node:fs")
const path = require("node:path")

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, "../assets/icon.svg"), "utf8")
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  win.webContents.setZoomFactor(1)
  await win.loadURL("data:text/html," + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`))
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  fs.writeFileSync(path.join(__dirname, "../assets/icon.png"), img.resize({ width: 1024, height: 1024 }).toPNG())
  app.quit()
})
