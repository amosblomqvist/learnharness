// Diagram drawing shared by the chat (ui/Diagram.tsx) and the hidden checker page (render.ts),
// so the picture the model looked at is the one you see.
import type { MermaidConfig } from "mermaid"

const CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict", // labels are sanitised; no scripts or click handlers
  theme: "base",
  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  themeVariables: {
    darkMode: true,
    background: "#16171e",
    fontSize: "14px",
    primaryColor: "#252a42",
    primaryTextColor: "#eeede8",
    primaryBorderColor: "#93a5ff",
    secondaryColor: "#2a2536",
    secondaryTextColor: "#eeede8",
    secondaryBorderColor: "#b39cff",
    tertiaryColor: "#1d1f29",
    tertiaryTextColor: "#eeede8",
    tertiaryBorderColor: "#6d6b66",
    lineColor: "#a9a7a0",
    textColor: "#eeede8",
    edgeLabelBackground: "#16171e",
    clusterBkg: "#1b1d27",
    clusterBorder: "#3a3d4d",
    noteBkgColor: "#2e2a1f",
    noteTextColor: "#eeede8",
    noteBorderColor: "#ffb45e",
    actorBkg: "#252a42",
    actorBorder: "#93a5ff",
    actorTextColor: "#eeede8",
    signalColor: "#a9a7a0",
    signalTextColor: "#eeede8"
  },
  flowchart: { htmlLabels: true, curve: "basis", padding: 10 }
}

let loading: Promise<typeof import("mermaid").default> | null = null
let n = 0
function mermaid() {
  loading ??= import("mermaid").then((m) => {
    m.default.initialize(CONFIG)
    return m.default
  })
  return loading
}

// The theme colours flowcharts for the dark window; a model's own light fills would leave
// light text on light boxes, so its style/classDef lines are dropped (here and in the checker alike).
export function themed(source: string): string {
  if (!/^\s*(graph|flowchart)\b/.test(source)) return source
  return source
    .split("\n")
    .filter((l) => !/^\s*(style|classDef|linkStyle)\s/.test(l))
    .map((l) => l.replace(/:::[\w-]+/g, ""))
    .join("\n")
}

// Returns the SVG markup (sanitised by mermaid) or throws with mermaid's own error message.
export async function mermaidSvg(source: string): Promise<string> {
  source = themed(source)
  const m = await mermaid()
  const id = `mmd-${Date.now().toString(36)}-${n++}`
  try {
    return (await m.render(id, source)).svg
  } finally {
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}

// A model-written SVG is only ever shown as an <img>, where scripts and links can't run.
// An <img> needs a size: without width/height, take it from the viewBox (at least 360px wide).
export function svgUrl(source: string): string {
  let svg = source.includes("xmlns=") ? source : source.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"')
  const open = /<svg\b[^>]*>/.exec(svg)?.[0] ?? ""
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(open)
  if (vb && !/\swidth\s*=/.test(open)) {
    const [w, h] = [Number(vb[1]), Number(vb[2])]
    const scale = Math.min(Math.max(360 / w, 1), 688 / w)
    svg = svg.replace(/<svg\b/, `<svg width="${Math.round(w * scale)}" height="${Math.round(h * scale)}"`)
  }
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)
}
