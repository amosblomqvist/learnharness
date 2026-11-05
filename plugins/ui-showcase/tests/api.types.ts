/** Compile-only public SDK contract checks; included by strict typecheck.
 * No host implementation imports and no runtime test or provider calls. */
import type {
  PluginButtonColors, PluginButtonColorState, PluginButtonProps, PluginFrontendContext, PluginKnowledgePickerProps, PluginSettingsRow,
  PluginStandardComposerProps, PluginSurfaceProps, PluginSurfaceTarget, PluginTreeProps, PluginUi, PluginWidgetHandle, PluginWidgetOptions,
} from "learnharness-plugin-api";
import type { mountGallery } from "../src/gallery.ts";
import type { REQUIRED_UI_METHODS } from "../src/main.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type GalleryMountContract = Assert<Equal<typeof mountGallery,
  (root: HTMLElement, context: PluginFrontendContext, signal: AbortSignal) => () => void>>;
export type EveryPublicWidgetIsRequired = Assert<Equal<Exclude<keyof PluginUi, typeof REQUIRED_UI_METHODS[number]>, never>>;
export type NativeTargetIsOpaque = Assert<Equal<{} extends PluginSurfaceTarget ? true : false, false>>;
export type SurfaceSupportsBothPublicOverloads = Assert<PluginUi["openSurface"] extends {
  (surface: PluginSurfaceProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginSurfaceProps>;
  (target: PluginSurfaceTarget, surface: PluginSurfaceProps, options: PluginWidgetOptions): PluginWidgetHandle<PluginSurfaceProps>;
} ? true : false>;
export type SurfaceBackgroundHasOnlyApprovedPresets = Assert<Equal<PluginSurfaceProps["background"], "dimmed" | "opaque" | undefined>>;
export type BackgroundIsAnOptionalProperty = Assert<Equal<{} extends Pick<PluginSurfaceProps, "background"> ? true : false, true>>;
export type BackgroundUpdatesStayPublic = Assert<Equal<Parameters<ReturnType<PluginUi["openSurface"]>["update"]>[0], Partial<PluginSurfaceProps>>>;
export type CustomButtonVariantIsPublic = Assert<Equal<Extract<PluginButtonProps["variant"], "custom">, "custom">>;
export type ButtonColorStatesUseCssStrings = Assert<Equal<PluginButtonColorState["background"], string | undefined>>;
export type ButtonPaletteIsOptional = Assert<Equal<PluginButtonProps["colors"], PluginButtonColors | undefined>>;
export type ButtonFocusRingIsOptional = Assert<Equal<NonNullable<PluginButtonColors["focusVisible"]>["ring"], string | undefined>>;
export type ButtonIconsUseTrustedSvgStrings = Assert<Equal<PluginButtonProps["icon"], string | undefined>>;
export type ButtonIconOnlyIsExplicit = Assert<Equal<PluginButtonProps["iconOnly"], boolean | undefined>>;
export type ButtonLabelStaysRequired = Assert<Equal<{} extends Pick<PluginButtonProps, "label"> ? true : false, false>>;
export type ButtonUpdatesRemainControlled = Assert<Equal<Parameters<ReturnType<PluginUi["mountButton"]>["update"]>[0], Partial<PluginButtonProps>>>;
export type KnowledgeSelectionUsesStableIds = Assert<Equal<PluginKnowledgePickerProps["value"], readonly string[]>>;
export type KnowledgeContextRemainsHostOwned = Assert<Equal<keyof PluginKnowledgePickerProps, "value" | "onChange" | "disabled">>;
export type SettingsCoverFiveTypes = Assert<Equal<PluginSettingsRow["type"], "toggle" | "text" | "dropdown" | "number" | "slider">>;
export type PresetReadinessRemainsOptional = Assert<Equal<PluginStandardComposerProps["composer"]["canSend"], boolean | undefined>>;
export type TreeMountConsumesPublicProps = Assert<Equal<Parameters<PluginUi["mountTree"]>[1], PluginTreeProps>>;
export type TreeUpdatesRemainControlled = Assert<Equal<Parameters<ReturnType<PluginUi["mountTree"]>["update"]>[0], Partial<PluginTreeProps>>>;

// No host implementation imports: icon markup is data, never a renderer or DOM node.
export function publicButtonExamples(ui: PluginUi, container: HTMLElement, signal: AbortSignal): void {
  const icon = '<svg viewBox="0 0 16 16"><path d="M4 8h8" /></svg>';
  ui.mountButton(container, { label: "Settings", icon, onClick() {} }, { signal });
  const gear = ui.mountButton(container, { label: "Settings", icon, iconOnly: true, size: "icon-sm", onClick() {} }, { signal });
  gear.update({ iconOnly: false, label: "Open settings" });
  const colors: PluginButtonColors = { background: "var(--plugin-fill)", text: "white", border: "transparent",
    hover: { background: "rgb(1 2 3 / .2)" }, active: { text: "black" },
    focusVisible: { border: "currentColor", ring: "var(--plugin-ring)" }, disabled: { text: "gray" } };
  const custom = ui.mountButton(container, { label: "Custom", variant: "custom", colors, onClick() {} }, { signal });
  custom.update({ colors: { hover: { text: "white" } } });
  custom.update({ variant: "outline" }); // Valid palette is retained, but ignored.
  custom.update({ variant: "custom", colors: undefined }); // Native custom defaults.
  // Current Flashcards consumer palette, expressed entirely through public props.
  for (const label of ["Again", "Hard", "Good", "Easy"]) {
    const color = `var(--fc-rating-${label.toLowerCase()})`;
    const tint = (percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
    ui.mountButton(container, { label, variant: "custom", colors: {
      background: tint(12), text: color, border: tint(55),
      hover: { background: tint(20), border: tint(75) },
      active: { background: tint(28), border: color },
      focusVisible: { border: color, ring: tint(50) },
    }, onClick() {} }, { signal });
  }
  // @ts-expect-error No arbitrary CSS properties or geometry overrides.
  custom.update({ colors: { position: "fixed" } });
  // @ts-expect-error CSS colors are strings, not style objects or numbers.
  custom.update({ colors: { background: 42 } });
  // @ts-expect-error Ring colors belong to focusVisible only.
  custom.update({ colors: { hover: { ring: "white" } } });
  // @ts-expect-error State slots contain color objects, not arbitrary CSS strings.
  custom.update({ colors: { disabled: "opacity: 0" } });
  // @ts-expect-error An icon-only button still requires its accessible label.
  ui.mountButton(container, { icon, iconOnly: true, onClick() {} }, { signal });
  // @ts-expect-error Icons accept trusted SVG strings, not custom renderers.
  gear.update({ icon: () => document.createElement("span") });
  // @ts-expect-error Icons are not DOM injection slots.
  gear.update({ icon: document.createElement("span") });
  // @ts-expect-error Icon-only presentation is a boolean, not a size or label.
  gear.update({ iconOnly: "icon" });
}

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
