import { createRoot } from "react-dom/client"
import { Study } from "./study/Study"
import "katex/dist/katex.min.css"
import "./styles.css"

createRoot(document.getElementById("root")!).render(<Study />)
