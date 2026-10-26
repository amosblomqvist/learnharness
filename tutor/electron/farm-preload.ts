// The farm window's bridge to Tutor (see farm.ts): the game finds window.tutor and uses it to
// count finished lessons as practice. (Tutor no longer answers questions; ? on the farm explains locally.)
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("tutor", {
  practice: (p: { node: string; title: string; project: boolean }) => ipcRenderer.invoke("farm:practice", p)
})
