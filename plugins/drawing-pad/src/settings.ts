export const DEFAULT_INK_COLOR = "#facc15";
export const DEFAULT_IMAGE_SCALE = 50;
export interface Settings { revision: number; inkColor: string; imageScale: number }
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ revision: 0, inkColor: DEFAULT_INK_COLOR, imageScale: DEFAULT_IMAGE_SCALE });

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
  if (Object.keys(input).some(key => key !== "revision" && key !== "inkColor" && key !== "imageScale") ||
    !Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new Error("Invalid Drawing Pad settings revision.");
  return { revision: input.revision as number, inkColor: parseColor(input.inkColor),
    imageScale: Object.hasOwn(input, "imageScale") ? parseImageScale(input.imageScale) : DEFAULT_IMAGE_SCALE };
}
export function parseColorChange(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !("inkColor" in value)) throw new Error("Expected an inkColor setting.");
  return parseColor((value as { inkColor: unknown }).inkColor);
}
