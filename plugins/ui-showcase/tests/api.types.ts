/** Compile-only public SDK contract checks; included by strict typecheck.
 * No host implementation imports and no runtime test or provider calls. */
import type {
  PluginFrontendContext, PluginKnowledgePickerProps, PluginSettingsRow,
  PluginStandardComposerProps, PluginSurfaceProps, PluginSurfaceTarget, PluginUi,
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
