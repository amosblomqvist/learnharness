import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Exact official release assets, independently verified before extraction. */
export const VIDEO_RUNTIMES = {
  "darwin-arm64": { archive: "raea-0.1.1-rc2-macos-arm64.tar.gz", size: 317870789, sha256: "562665a143cb81d0ebcb18e723fe0e64f40ae55c0f91b3014cc46f726e2b45e3", downloadMiB: 303, disk: "about 1.1 GiB installed" },
  "linux-x64": { archive: "raea-0.1.1-rc2-linux-x86_64.tar.gz", size: 1007739728, sha256: "cbcc68d9c671414114429b33110d914730414a2884fa1eb081523ef65115f4fe", downloadMiB: 961, disk: "additional disk space required" },
  "win32-x64": { archive: "raea-0.1.1-rc2-windows-x86_64.zip", size: 263622027, sha256: "5832df4fcd7b79002db6cdcbbf8d323ac7ca3bed7ea9cf8595bf7a6efec7f4bc", downloadMiB: 251, disk: "additional disk space required" },
} as const;
export function videoRuntime(platform: string, arch: string) {
  return VIDEO_RUNTIMES[`${platform}-${arch}` as keyof typeof VIDEO_RUNTIMES];
}

const coordinate = Type.Number({ minimum: 0, maximum: 1 });
const element = Type.Object({
  kind: Type.Union([Type.Literal("text"), Type.Literal("rect"), Type.Literal("circle"), Type.Literal("line")]),
  x: coordinate, y: coordinate, width: coordinate, height: coordinate,
  color: Type.Union([Type.Literal("blue"), Type.Literal("yellow"), Type.Literal("white"), Type.Literal("green"), Type.Literal("red")]),
  text: Type.Optional(Type.String({ maxLength: 100 })),
}, { additionalProperties: false });
export const videoSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 100 }),
  scenes: Type.Array(Type.Object({
    heading: Type.String({ minLength: 1, maxLength: 80 }),
    caption: Type.String({ maxLength: 140 }),
    seconds: Type.Number({ minimum: 2, maximum: 5 }),
    elements: Type.Array(element, { maxItems: 12 }),
  }, { additionalProperties: false }), { minItems: 2, maxItems: 5 }),
}, { additionalProperties: false });
export type VideoPlan = Static<typeof videoSchema>;
export function validVideoPlan(value: unknown): value is VideoPlan {
  return Value.Check(videoSchema, value) && value.scenes.every(s => Number.isFinite(s.seconds) && s.elements.every(e => [e.x,e.y,e.width,e.height].every(Number.isFinite)));
}

/** Keep original indices for reveal timing while painting labels above shapes. */
export function videoPaintOrder(elements: VideoPlan["scenes"][number]["elements"]): number[] {
  return elements.map((_, index) => index).filter(index => elements[index]!.kind !== "text")
    .concat(elements.map((_, index) => index).filter(index => elements[index]!.kind === "text"));
}
