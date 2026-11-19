/** The teacher supplies a complete test process recipe, not a language profile. */
export type CodingTests = {
  program: string;
  args: string[];
  code: string;
};

/** A test-process observation, never a claim that the learner's code is correct. */
export type CodingTestResult = {
  status: "passed" | "failed" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  message?: string;
};

/** Defensive reading of saved plugin data; never coerce or infer a missing result. */
export function readTestResult(value: unknown): CodingTestResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.status !== "passed" && result.status !== "failed" && result.status !== "error") return null;
  if (result.exitCode !== null && (typeof result.exitCode !== "number" || !Number.isSafeInteger(result.exitCode))) return null;
  if (result.status === "passed" && result.exitCode !== 0) return null;
  if (result.status === "failed" && (result.exitCode === null || result.exitCode === 0)) return null;
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string" || typeof result.stdoutTruncated !== "boolean" || typeof result.stderrTruncated !== "boolean") return null;
  if (result.message !== undefined && typeof result.message !== "string") return null;
  return result as CodingTestResult;
}
