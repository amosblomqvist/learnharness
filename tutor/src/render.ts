// The hidden page electron/diagram.ts draws into. Same drawing code and sizes as the chat.
import { mermaidSvg, svgUrl } from "./diagram"

declare global {
  interface Window {
    renderDiagram(kind: "mermaid" | "svg", source: string): Promise<{ ok: boolean; error?: string; width?: number; height?: number }>
  }
}

window.renderDiagram = async (kind, source) => {
  const out = document.getElementById("out")!
  out.innerHTML = ""
  out.className = kind
  try {
    if (kind === "mermaid") out.innerHTML = await mermaidSvg(source)
    else {
      const img = new Image()
      img.src = svgUrl(source)
      await img.decode().catch(() => {
        throw new Error("The SVG isn't valid (the browser couldn't draw it). Check it's well-formed XML with a viewBox.")
      })
      out.appendChild(img)
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const box = out.getBoundingClientRect()
    return { ok: true, width: box.width, height: box.height }
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 1200) }
  }
}
