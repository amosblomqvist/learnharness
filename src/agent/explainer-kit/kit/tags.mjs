// Data tags: the numbers go in, the kit's SVG comes out, on an exact scale that starts at zero.
//   <ve-bars unit="ms" max="9" label="…"><ve-bar value="1" hot>hit</ve-bar>…</ve-bars>   rows in the order written
//   <ve-waffle value="94" note="6 misses" label="…"></ve-waffle>                           100 cells, the first N on
//   <ve-stack unit="k" label="…"><ve-bar value="3.5">SKILL.md</ve-bar>…</ve-stack>        one bar split in proportion
import { esc, kids, textOf } from "./html.mjs";

const CH = 8; // a mono character at 13–14 units, rounded up, for sizing label columns

// "1 ms" and "4 MB" take a no-break space; "3.5k" and "13%" do not.
const withUnit = (v, unit) => (unit ? `${v}${unit.length > 1 ? "\u00a0" : ""}${unit}` : v);

function values(n, { errors, warnings, where }) {
  if (!n.attrs.label) warnings.push(`${where(n)}: add label="…", one sentence a screen reader can read instead of the picture`);
  const rows = [];
  for (const k of kids(n)) {
    if (k.name !== "ve-bar") { errors.push(`${where(k)}: only <ve-bar> belongs in <${n.name}>`); continue; }
    const raw = (k.attrs.value ?? "").trim(), value = Number(raw);
    if (raw === "" || !Number.isFinite(value)) errors.push(`${where(k)}: value="${raw}" is not a number`);
    else if (value < 0) errors.push(`${where(k)}: value="${raw}" is negative; bars start at zero`);
    else rows.push({ raw, value, name: textOf(k).trim(), hot: "hot" in k.attrs });
  }
  if (!rows.length && !kids(n).length) errors.push(`${where(n)}: needs at least one <ve-bar value="…">`);
  return rows;
}

function bars(n, ctx) {
  const rows = values(n, ctx), unit = n.attrs.unit || "";
  let max = Math.max(0, ...rows.map((r) => r.value));
  if (n.attrs.max !== undefined) {
    const m = Number(n.attrs.max);
    if (!Number.isFinite(m) || m <= 0) ctx.errors.push(`${ctx.where(n)}: max="${n.attrs.max}" must be a number above zero`);
    else if (m < max) ctx.errors.push(`${ctx.where(n)}: max="${n.attrs.max}" is below the largest value, ${max}`);
    else max = m;
  }
  if (!rows.length) return "";
  // A shared max means a shared scale, so those charts all use the same fixed columns; others fit their own labels.
  const shared = n.attrs.max !== undefined;
  if (shared) for (const r of rows) {
    if (r.name.length > 9) ctx.errors.push(`${ctx.where(n)}: "${r.name}" is longer than 9 characters, the label column of a shared scale`);
    if (withUnit(r.raw, unit).length > 6) ctx.errors.push(`${ctx.where(n)}: "${withUnit(r.raw, unit)}" is longer than 6 characters, the value column of a shared scale`);
  }
  const labelW = shared ? 9 * CH + 12 : Math.max(...rows.map((r) => r.name.length)) * CH + 12;
  const valueW = shared ? 6 * CH + 8 : Math.max(...rows.map((r) => withUnit(r.raw, unit).length)) * CH + 8;
  // long labels or values widen the drawing, so a bar always has at least 60 units to grow in
  const span = Math.max(240 - labelW - valueW, 60), width = labelW + span + valueW;
  const svg = rows.map((r, i) => {
    const y = 12 + i * 28, w = max ? Math.round((r.value / max) * span * 100) / 100 : 0;
    return `<text y="${y}">${esc(r.name)}</text><rect${r.hot ? ' class="hot"' : ""} x="${labelW}" y="${y - 7}" width="${w}" height="14" rx="2"/><text x="${labelW + w + 8}" y="${y}">${esc(withUnit(r.raw, unit))}</text>`;
  }).join("");
  // a widened chart may grow past the 16rem cap in step, so its labels keep their size
  const cap = width > 240 ? ` style="max-width:${Math.round((width / 240) * 1600) / 100}rem"` : "";
  return `<svg class="ve-bars"${cap} viewBox="0 0 ${width} ${rows.length * 28 - 4}" role="img" aria-label="${esc(n.attrs.label || "")}">${svg}</svg>`;
}

function waffle(n, { errors, warnings, where }) {
  if (!n.attrs.label) warnings.push(`${where(n)}: add label="…", one sentence a screen reader can read instead of the picture`);
  const raw = (n.attrs.value ?? "").trim(), v = Number(raw);
  if (raw === "" || !Number.isInteger(v) || v < 0 || v > 100) { errors.push(`${where(n)}: value="${raw}" must be a whole number from 0 to 100`); return ""; }
  // the first v cells are on, row by row from the top left
  const full = Math.floor(v / 10), part = v % 10, cells = [];
  const on = (x, y, w, h) => w && h && cells.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#ve-w-on)"/>`);
  const off = (x, y, w, h) => w && h && cells.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#ve-w-off)"/>`);
  on(0, 0, 100, full * 10);
  on(0, full * 10, part * 10, part ? 10 : 0);
  off(part * 10, full * 10, part ? 100 - part * 10 : 0, part ? 10 : 0);
  off(0, (full + (part ? 1 : 0)) * 10, 100, (10 - full - (part ? 1 : 0)) * 10);
  const y = full * 10 + 5; // the row of the first off cell
  const note = n.attrs.note && v < 100 ? `<path class="ann" d="M104 ${y}H114"/><text x="118" y="${y}">${esc(n.attrs.note)}</text>` : "";
  return `<svg class="ve-waffle" viewBox="0 0 170 100" role="img" aria-label="${esc(n.attrs.label || "")}">${cells.join("")}${note}</svg>`;
}

function stack(n, ctx) {
  const rows = values(n, ctx), unit = n.attrs.unit || "";
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (!rows.length) return "";
  if (!total) { ctx.errors.push(`${ctx.where(n)}: the values add up to zero; there is nothing to split`); return ""; }
  const WIDTH = 800, BAR = 40, ROW = 24;
  let x = 0;
  const segs = rows.map((r) => { const w = (r.value / total) * WIDTH, s = { ...r, x, w }; x += w; return s; });
  // each label sits under its segment; a label that would overlap the one before it drops to the next free row
  const ends = [];
  for (const s of segs) {
    const text = `${s.name} ${withUnit(s.raw, unit)}`, tw = text.length * CH;
    const cx = Math.min(Math.max(s.x + s.w / 2, tw / 2), WIDTH - tw / 2);
    let row = 0;
    while (ends[row] !== undefined && ends[row] + 12 > cx - tw / 2) row++;
    ends[row] = cx + tw / 2;
    Object.assign(s, { text, cx, row });
  }
  const rowsUsed = ends.length;
  const svg = segs.map((s) => {
    const r = (v) => Math.round(v * 100) / 100;
    const ly = BAR + 22 + s.row * ROW;
    const leader = s.row ? `<path class="ann" d="M${r(s.x + s.w / 2)} ${BAR}V${ly - 12}"/>` : "";
    return `<rect${s.hot ? ' class="hot"' : ""} x="${r(s.x)}" y="0" width="${r(s.w)}" height="${BAR}"/>${leader}<text x="${r(s.cx)}" y="${ly}">${esc(s.text)}</text>`;
  }).join("");
  return `<svg class="ve-svg ve-stack" viewBox="0 0 ${WIDTH} ${BAR + 30 + (rowsUsed - 1) * ROW}" role="img" aria-label="${esc(n.attrs.label || "")}">${svg}</svg>`;
}

export const TAGS = { "ve-bars": bars, "ve-waffle": waffle, "ve-stack": stack };
