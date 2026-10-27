/**
 * Fork update policy (ADR-0001, docs/adr/0001-hard-fork-from-upstream.md).
 *
 * Off: the fork has no release channel yet. While off, the shell never loads
 * electron-updater, makes no update requests, schedules no checks, and drops
 * "Check for Updates…" from the menu; Settings hides its update controls
 * because the reported status is "disabled".
 *
 * To re-enable against the fork's own releases: confirm the `publish` block
 * in electron-builder.yml names the fork, publish a release there, then set
 * this to true.
 */
module.exports = { AUTO_UPDATE_ENABLED: false };
