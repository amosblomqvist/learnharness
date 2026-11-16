/**
 * Loaded before every test file (`npm test`): the suite runs with
 * NODE_ENV=test, so no test reaches a real provider. Set here rather than in
 * the npm script because npm runs scripts through cmd.exe on Windows, which
 * cannot parse `NODE_ENV=test command`.
 */
(process.env as Record<string, string | undefined>).NODE_ENV = "test"; // read-only in Next's types
