// npm run dev: Vite (hot reload for the UI) + esbuild watch (restarts Electron when main-process code changes).
import { spawn } from "node:child_process"
import { createServer } from "vite"
import electronPath from "electron"
import { watchElectron } from "./build-electron.mjs"

const server = await createServer({ server: { port: 5190, strictPort: true } })
await server.listen()
const url = "http://localhost:5190"

let child = null
function restart() {
  if (child) {
    child.removeAllListeners("exit")
    child.kill()
  }
  child = spawn(electronPath, ["."], { stdio: "inherit", env: { ...process.env, TUTOR_DEV_URL: url } })
  child.on("exit", () => process.exit(0))
}
await watchElectron(restart)
