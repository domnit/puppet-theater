// Headless frame → SVG string. No DOM. Used by scripts/snapshot.ts to save
// review stills, and later by anything that needs a still server-side.

import { STAGE_H, STAGE_W, type Frame } from "../engine/evaluate";
import { apply, magnitude, matToString } from "../engine/math";
import { INK, stageBackdrop, stageDefs, stageForeground } from "./markup";

export interface SnapshotOptions {
  rods?: boolean;
}

export function frameToSvg(frame: Frame, opts: SnapshotOptions = {}): string {
  const rods = opts.rods ?? true;
  const cast: string[] = [];
  for (const fp of frame.puppets) {
    const parts: string[] = [];
    if (rods) {
      const [rx, ry] = apply(fp.root, [0, 0]);
      const w = 2.2 * magnitude(fp.root) * fp.puppet.unit / 100;
      parts.push(`<line x1="${rx.toFixed(2)}" y1="${ry.toFixed(2)}" x2="${rx.toFixed(2)}" y2="${STAGE_H + 10}" stroke="${INK}" stroke-width="${w.toFixed(2)}" stroke-linecap="round"/>`);
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
