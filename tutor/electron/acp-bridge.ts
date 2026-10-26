// The command PyCharm / WebStorm run for the "Tutor" agent in their AI chat: it passes the IDE's ACP
// messages (stdin/stdout) to the running Tutor over a local socket, starting Tutor if it isn't running.
// Run with the Tutor app itself in Node mode: ELECTRON_RUN_AS_NODE=1 …/Tutor.app/Contents/MacOS/Electron acp-bridge.cjs <socket>
import net from "node:net"
import { spawn } from "node:child_process"

const sock = process.argv[2]
if (!sock) {
  process.stderr.write("usage: acp-bridge <socket>\n")
  process.exit(2)
}

let launched = false
function connect(tries: number): void {
  const s = net.connect(sock)
  s.once("connect", () => {
    process.stdin.pipe(s)
    s.pipe(process.stdout)
    s.on("close", () => process.exit(0))
    process.stdin.on("end", () => s.end())
  })
  s.once("error", () => {
    if (!launched) {
      launched = true
      spawn("/usr/bin/open", ["-g", "-a", "Tutor"], { stdio: "ignore", detached: true }).unref()
    }
    if (tries > 80) {
      process.stderr.write("Tutor isn't running and couldn't be started. Open Tutor, then try again.\n")
      process.exit(1)
    }
    setTimeout(() => connect(tries + 1), 250)
  })
}
connect(0)
