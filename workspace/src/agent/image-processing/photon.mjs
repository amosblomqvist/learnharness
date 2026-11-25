// Adapted from @earendil-works/pi-coding-agent 1.1.0, dist/utils/photon.js (MIT).
// Source-vs-runtime adaptation: this app runs in Node/Electron, not a Bun
// compiled executable. Photon loads its colocated WASM normally; no global fs
// monkeypatch or executable-relative WASM fallback is needed.
let photonModule = null;
let loadPromise = null;

export async function loadPhoton() {
    if (photonModule) return photonModule;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
        try {
            photonModule = await import("@silvia-odwyer/photon-node");
            return photonModule;
        } catch {
            photonModule = null;
            return photonModule;
        }
    })();
    return loadPromise;
}
