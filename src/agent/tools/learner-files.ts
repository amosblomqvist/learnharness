import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LEARNER_FILES_AVAILABLE } from "../../../config.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";

/**
 * The learner-filesystem set (read / ls / find / grep) for a tool registry —
 * always-on wherever the app has a home directory to search (user-decided
 * 2026-09, sources v1); empty in the phone build (config.ts
 * LEARNER_FILES_AVAILABLE), which has none.
 */
export function learnerFileTools(): Record<string, AgentTool<any>> {
	return LEARNER_FILES_AVAILABLE ? { read: readTool, ls: lsTool, find: findTool, grep: grepTool } : {};
}
