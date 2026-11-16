// TeX breaks its log at this column, mid-word: a line this wide continues on the next.
const TEX_LINE_WIDTH = 79;
const TEX_ERROR_LIMIT = 300;
// Start of what the pinned engine throws whenever TeX ran but wrote no DVI.
const ENGINE_FAILURE = "TeX engine render failed";

/**
 * Runs one engine compile. When TeX wrote no output, the failure names TeX's
 * first error instead of the engine's hint about an option learners cannot set.
 * The engine exposes TeX's log only through console.log (showConsole), so that
 * is captured while the compile runs; one bounded error is kept, nothing else.
 * Results and every other failure pass through untouched. Like the engine, this
 * is not reentrant: the worker runs one compile at a time.
 */
export async function withTexLog<T>(compile: () => Promise<T>): Promise<T> {
  let error: string | undefined, broken = false;
  const log = console.log;
  console.log = (line: unknown) => {
    if (typeof line !== "string") return;
    if (error === undefined) { if (line.startsWith("! ")) { error = line.slice(2); broken = line.length === TEX_LINE_WIDTH; } }
    else if (broken) { error += line; broken = line.length === TEX_LINE_WIDTH && error.length < TEX_ERROR_LIMIT; }
  };
  try { return await compile(); }
  catch (caught) {
    if (!(caught instanceof Error) || !caught.message.startsWith(ENGINE_FAILURE)) throw caught;
    if (error === undefined) throw new Error(`${ENGINE_FAILURE}.`);
    throw new Error(`${ENGINE_FAILURE}: ${error.length > TEX_ERROR_LIMIT ? `${error.slice(0, TEX_ERROR_LIMIT)}…` : error}`);
  } finally { console.log = log; }
}
