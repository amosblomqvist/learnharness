import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

/** Thin standalone renders share the same interaction context as AppShell. */
export function renderWithInteractionLayers(node: ReactNode) {
	return renderToStaticMarkup(<InteractionLayersProvider>{node}</InteractionLayersProvider>);
}
