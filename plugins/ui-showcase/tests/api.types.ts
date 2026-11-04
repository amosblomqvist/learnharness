/** Compile-only public SDK contract checks; included by strict typecheck.
 * No host implementation imports and no runtime test or provider calls. */
import type {
  PluginFrontendContext, PluginKnowledgePickerProps, PluginSettingsRow,
  PluginStandardComposerProps, PluginSurfaceProps, PluginSurfaceTarget, PluginTreeProps, PluginUi,
} from "learnharness-plugin-api";
import type { mountGallery } from "../src/gallery.ts";
import type { REQUIRED_UI_METHODS } from "../src/main.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type GalleryMountContract = Assert<Equal<typeof mountGallery,
  (root: HTMLElement, context: PluginFrontendContext, signal: AbortSignal) => () => void>>;
export type EveryPublicWidgetIsRequired = Assert<Equal<Exclude<keyof PluginUi, typeof REQUIRED_UI_METHODS[number]>, never>>;
export type NativeTargetIsOpaque = Assert<Equal<{} extends PluginSurfaceTarget ? true : false, false>>;
export type SurfaceConsumesOnlyHostTarget = Assert<Equal<Parameters<PluginUi["openSurface"]>[0], PluginSurfaceTarget>>;
export type SurfaceBackgroundHasOnlyApprovedPresets = Assert<Equal<PluginSurfaceProps["background"], "dimmed" | "opaque" | undefined>>;
export type BackgroundIsAnOptionalProperty = Assert<Equal<{} extends Pick<PluginSurfaceProps, "background"> ? true : false, true>>;
export type BackgroundUpdatesStayPublic = Assert<Equal<Parameters<ReturnType<PluginUi["openSurface"]>["update"]>[0], Partial<PluginSurfaceProps>>>;
export type KnowledgeSelectionUsesStableIds = Assert<Equal<PluginKnowledgePickerProps["value"], readonly string[]>>;
export type KnowledgeContextRemainsHostOwned = Assert<Equal<keyof PluginKnowledgePickerProps, "value" | "onChange" | "disabled">>;
export type SettingsCoverFiveTypes = Assert<Equal<PluginSettingsRow["type"], "toggle" | "text" | "dropdown" | "number" | "slider">>;
export type PresetReadinessRemainsOptional = Assert<Equal<PluginStandardComposerProps["composer"]["canSend"], boolean | undefined>>;
export type TreeMountConsumesPublicProps = Assert<Equal<Parameters<PluginUi["mountTree"]>[1], PluginTreeProps>>;
export type TreeUpdatesRemainControlled = Assert<Equal<Parameters<ReturnType<PluginUi["mountTree"]>["update"]>[0], Partial<PluginTreeProps>>>;

// Positive SDK-only fixture: strings, rich content, hierarchy, metadata and
// independent controlled callbacks must compile without implementation imports.
export const publicTreeExample: PluginTreeProps = {
  label: "Compile-only tree", header: "Name",
  columns: [{ key: "kind", header: "Kind", width: "5rem" }, { key: "count", header: "Count", width: 56, align: "right" }],
  rows: [{
    key: "parent", content: "Folder", cells: { kind: "Folder", count: "1" },
    disclosure: { label: "Toggle folder", expanded: true, onChange(expanded: boolean) { void expanded; } },
    selection: { label: "Select folder", checked: false, onChange(checked: boolean) { void checked; } },
    children: [{ key: "parent/child", content(container, signal) {
      const input = document.createElement("input"); input.disabled = signal.aborted; container.append(input);
      return () => input.remove();
    } }],
  }],
};
