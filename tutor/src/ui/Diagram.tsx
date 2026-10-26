// ```mermaid and ```svg blocks draw as pictures, with the same code the model used to check them.
// While an answer is still streaming the block may be half-written, so errors only show once it's done.
import { useEffect, useState } from "react"
import { mermaidSvg, svgUrl } from "../diagram"
import * as I from "../icons"

export function Diagram({ kind, code, live }: { kind: "mermaid" | "svg"; code: string; live: boolean }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [source, setSource] = useState(false)
  const [big, setBig] = useState(false)

  useEffect(() => {
    if (kind !== "mermaid") return
    let off = false
    const t = setTimeout(
      () =>
        mermaidSvg(code)
          .then((s) => !off && (setSvg(s), setErr(null)))
          .catch((e: Error) => !off && setErr(String(e.message ?? e))),
      live ? 400 : 0
    )
    return () => {
      off = true
      clearTimeout(t)
    }
  }, [code, kind, live])

  const failed = kind === "mermaid" && !!err && !live && !svg
  return (
    <div className={`diagram ${kind} ${big ? "big" : ""}`}>
      <div className="code-bar">
        <span>{kind === "mermaid" ? "diagram" : "figure"}</span>
        <div className="code-actions">
          <button onClick={() => setSource(!source)} title={source ? "Show the picture" : "Show the source"}>
            <I.Code size={12} /> {source ? "Picture" : "Source"}
          </button>
          {!source && (
            <button onClick={() => setBig(!big)} title={big ? "Fit to the window" : "Full size (scrolls sideways)"}>
              {big ? <I.Narrow size={12} /> : <I.Wide size={12} />}
            </button>
          )}
          <button onClick={() => navigator.clipboard.writeText(code)} title="Copy the source">
            <I.Copy size={12} />
          </button>
        </div>
      </div>
      {source || failed ? (
        <>
          {failed && <div className="diagram-err">Couldn't draw this: {err}</div>}
          <pre className="diagram-src">{code}</pre>
        </>
      ) : kind === "svg" ? (
        <div className="diagram-body">
          <img src={svgUrl(code)} alt="Figure" onError={() => setErr("invalid SVG")} />
        </div>
      ) : svg ? (
        <div className="diagram-body" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="diagram-wait">Drawing…</div>
      )}
    </div>
  )
}
