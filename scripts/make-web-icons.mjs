
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
const svg = fs.readFileSync("build/icon-flat.svg", "utf-8");
for (const [size, out] of [[192,"public/icons/icon-192.png"],[512,"public/icons/icon-512.png"],[180,"public/icons/apple-touch-icon.png"],[32,"public/icons/favicon-32.png"]]) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
  fs.writeFileSync(out, png);
  console.log(out, png.length);
}
