"use client";

import { createContext } from "react";
import type { JobRecord } from "@/src/core";

/**
 * Background-job observability channel (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * ONE central fetch (in Chat) reads GET /api/jobs?chatId=… and publishes
 * the list here — on mount, per jobs-changed announcement (the store emits
 * post-write), and on channel resync (push-architecture S4, 2026-10-02);
 * every job surface consumes it — the transcript dispatch cards (the ack
 * box with live status) and the sub-agents sidebar panel. Cards used to
 * each run their own poller on input-available parts; under the
 * ack-protocol the tool part resolves immediately, so the fetch moved
 * to the composition root and the cards became pure renderers of this data.
 */
export const JobsContext = createContext<JobRecord[]>([]);
