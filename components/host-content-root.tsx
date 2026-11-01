"use client";

import { createContext } from "react";

/** The host's content column, excluding the sidebar. Portals retain app contexts. */
export const HostContentRootContext = createContext<HTMLElement | null>(null);
