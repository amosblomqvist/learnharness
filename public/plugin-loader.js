// Deliberately served as a native browser module, outside the Next bundle.
// Plugins are trusted local code, not sandboxed modules.
window.__lhImportPlugin = (url) => import(url);
