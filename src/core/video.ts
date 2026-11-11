import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

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
