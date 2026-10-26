import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  base: "./",
  plugins: [react()],
  // render.html is the hidden page that draws diagrams for the model to check (electron/diagram.ts).
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: { main: "index.html", render: "render.html" } } }
})
