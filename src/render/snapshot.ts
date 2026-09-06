// Headless frame → SVG string. No DOM. Used by scripts/snapshot.ts to save
// review stills, and later by anything that needs a still server-side.

import { STAGE_H, STAGE_W, type Frame } from "../engine/evaluate";
import { matToString } from "../engine/math";
import { INK, ROD_OPACITY, stageBackdrop, stageDefs, stageForeground } from "./markup";

export interface SnapshotOptions {
  /** Draw the main rods. */
  rods?: boolean;
  /** Draw the hand rods too. */
  handRods?: boolean;
}

export function frameToSvg(frame: Frame, opts: SnapshotOptions = {}): string {
  const rods = opts.rods ?? true;
  const handRods = opts.handRods ?? true;
  const cast: string[] = [];
  for (const fp of frame.puppets) {
    const parts: string[] = [];
    const shown = fp.rods.filter((r) => (r.main ? rods : rods && handRods));
    if (shown.length) {
      parts.push(`<g class="rods" filter="url(#blur-rod)" opacity="${ROD_OPACITY}">`);
      for (const r of shown) {
        parts.push(`<line data-rod="${r.part.id}" x1="${r.x1.toFixed(2)}" y1="${r.y1.toFixed(2)}" x2="${r.x2.toFixed(2)}" y2="${r.y2.toFixed(2)}" stroke="${INK}" stroke-width="${r.width.toFixed(2)}" stroke-linecap="round"/>`);
      }
      parts.push(`</g>`);
    }
    for (const part of fp.parts) {
      parts.push(`<g data-part="${part.part.id}" transform="${matToString(part.world)}"><path d="${part.part.d}" fill="${INK}"/><circle r="${fp.puppet.cap}" fill="${INK}"/></g>`);
    }
    cast.push(`<g data-id="${fp.puppet.id}" filter="url(#blur-${fp.plane})" opacity="${fp.opacity.toFixed(3)}">\n${parts.join("\n")}\n</g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${STAGE_W} ${STAGE_H}">
${stageDefs()}
${stageBackdrop()}
<g class="cast">
${cast.join("\n")}
</g>
${stageForeground(frame.lamp)}
</svg>`;
}
