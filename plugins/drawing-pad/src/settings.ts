export const DEFAULT_DARK_INK_COLOR = "#ffffff";
export const DEFAULT_LIGHT_INK_COLOR = "#000000";
export const DEFAULT_IMAGE_SCALE = 50;
export interface Settings { revision: number; darkInkColor: string; lightInkColor: string; imageScale: number }
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ revision: 0,
  darkInkColor: DEFAULT_DARK_INK_COLOR, lightInkColor: DEFAULT_LIGHT_INK_COLOR, imageScale: DEFAULT_IMAGE_SCALE });

export function imageScaleError(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
    ? undefined : "Enter a percentage greater than 0 and at most 100.";
}
export function parseImageScale(value: unknown): number {
  const error = imageScaleError(value);
  if (error) throw new Error(error);
  return value as number;
}
export function parseImageScaleChange(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !("imageScale" in value)) throw new Error("Expected an imageScale setting.");
  return parseImageScale((value as { imageScale: unknown }).imageScale);
}

export function colorError(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? undefined : "Use a six-digit hex color, for example #facc15.";
}
export function parseColor(value: unknown): string {
  const error = colorError(value);
  if (error) throw new Error(error);
  return (value as string).toLowerCase();
}
export function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Drawing Pad settings.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "revision" && key !== "darkInkColor" && key !== "lightInkColor" && key !== "imageScale") ||
    !Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new Error("Invalid Drawing Pad settings revision.");
  return { revision: input.revision as number, darkInkColor: parseColor(input.darkInkColor), lightInkColor: parseColor(input.lightInkColor),
    imageScale: Object.hasOwn(input, "imageScale") ? parseImageScale(input.imageScale) : DEFAULT_IMAGE_SCALE };
}
export type ColorChange = { darkInkColor: string; lightInkColor?: never } | { lightInkColor: string; darkInkColor?: never };
export function parseColorChange(value: unknown): ColorChange {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1)
    throw new Error("Expected exactly one darkInkColor or lightInkColor setting.");
  const input = value as Record<string, unknown>, key = Object.keys(input)[0];
  if (key === "darkInkColor") return { darkInkColor: parseColor(input.darkInkColor) };
  if (key === "lightInkColor") return { lightInkColor: parseColor(input.lightInkColor) };
  throw new Error("Expected exactly one darkInkColor or lightInkColor setting.");
}
