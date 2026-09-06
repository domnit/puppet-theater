// Stage markup shared by the live SVG DOM renderer and the headless snapshot
// renderer, so a saved frame is pixel-for-pixel what the harness shows.

import { PLANES, STAGE_H, STAGE_W } from "../engine/evaluate";
import type { Plane } from "../model/types";

export const INK = "#14100c";
/** Rods are held behind the figure, farther from the screen: a touch softer and lighter than the puppet. */
export const ROD_OPACITY = 0.78;
export const ROD_BLUR = 1.3;

export function stageDefs(): string {
  return `<defs>
    <radialGradient id="lamp" cx="50%" cy="38%" r="72%" fx="50%" fy="34%">
      <stop offset="0" stop-color="#f7ead0"/>
      <stop offset="0.35" stop-color="#ebd3a2"/>
      <stop offset="0.7" stop-color="#c2955a"/>
      <stop offset="1" stop-color="#5a3a1f"/>
    </radialGradient>
    <radialGradient id="vignette" cx="50%" cy="50%" r="75%">
      <stop offset="0.55" stop-color="#1a0d08" stop-opacity="0"/>
      <stop offset="1" stop-color="#1a0d08" stop-opacity="0.65"/>
    </radialGradient>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="11" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="table" tableValues="0 0.22"/></feComponentTransfer>
    </filter>
    <pattern id="weave" width="5" height="5" patternUnits="userSpaceOnUse">
      <rect x="0" y="0" width="5" height="1" fill="#3a2410" opacity="0.5"/>
      <rect x="0" y="0" width="1" height="5" fill="#3a2410" opacity="0.5"/>
    </pattern>
    <filter id="blur-rod" x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur stdDeviation="${ROD_BLUR}"/></filter>
    ${(["far", "mid", "near"] as Plane[]).map((p) => `<filter id="blur-${p}" x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur stdDeviation="${PLANES[p].blur}"/></filter>`).join("\n    ")}
  </defs>`;
}

/** Lit scrim, weave and grain — everything behind the cast. */
export function stageBackdrop(): string {
  return `<rect class="scrim" width="${STAGE_W}" height="${STAGE_H}" fill="url(#lamp)" pointer-events="none"/>
  <rect width="${STAGE_W}" height="${STAGE_H}" fill="url(#weave)" opacity="0.10" pointer-events="none"/>
  <rect width="${STAGE_W}" height="${STAGE_H}" filter="url(#grain)" style="mix-blend-mode:multiply" pointer-events="none"/>`;
}

/**
 * Lamp dimmer, vignette and proscenium — everything in front of the cast.
 * None of it is hit-testable, so a click lands on a figure or on nothing.
 */
export function stageForeground(lamp: number): string {
  const dim = 1 - Math.max(0, Math.min(1, lamp));
  return `<rect class="dim" width="${STAGE_W}" height="${STAGE_H}" fill="#0b0705" opacity="${dim.toFixed(3)}" pointer-events="none"/>
  <rect width="${STAGE_W}" height="${STAGE_H}" fill="url(#vignette)" pointer-events="none"/>
  <path class="proscenium" fill="#1b0f0b" fill-rule="evenodd" pointer-events="none" d="M0,0 H${STAGE_W} V${STAGE_H} H0 Z M36,58 Q${STAGE_W / 2},22 ${STAGE_W - 36},58 V${STAGE_H - 34} H36 Z"/>`;
}
