/**
 * The hang guard for tests that start a child Node process (spawnSync of a
 * script, often through tsx and the app's modules). It exists to fail a
 * child that never exits, not to time a healthy one, so it sits far above
 * the slowest healthy run.
 *
 * Measured 13-11-2026 on the 24-core dev machine (F8): one cold child takes
 * about 2 s on an idle machine, and about 12 s with 48 starting at once. The
 * full suite runs test files in parallel (with coverage, often beside a dev
 * server), and a 15 s guard timed out healthy children there.
 */
export const CHILD_HANG_GUARD_MS = 120_000;

/**
 * The flags that load the test process's own loader (tsx), for a child Node
 * process that runs repo files (N3, settled 14-11-2026). Coverage is merged
 * per file by character position, so a file the test imports (through tsx)
 * and a child also runs must reach V8 as the same text: run plain, it
 * differs, and the merged coverage changes from run to run. A file URL, not
 * a path: Node reads a Windows path such as C:\... as a URL scheme.
 */
export const LOADER_ARGS: readonly string[] = ["--import", import.meta.resolve("tsx")];
