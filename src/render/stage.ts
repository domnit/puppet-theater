// SVG stage: lit scrim, dark figures, depth planes, and toggleable debug
// overlays. The DOM is built once per cast and only attributes change per frame.

import type { ResolvedPuppet } from "../model/puppet";
import { STAGE_H, STAGE_W, type Frame, type FramePart, type FramePuppet } from "../engine/evaluate";
import { apply, magnitude, matToString, type Mat } from "../engine/math";
import { INK, stageBackdrop, stageDefs, stageForeground } from "./markup";

const NS = "http://www.w3.org/2000/svg";

export interface OverlayOptions {
  pivots: boolean;
  bounds: boolean;
  bboxes: boolean;
  caps: boolean;
}
export interface DrawOptions {
  rods: boolean;
  overlays: OverlayOptions;
  selected?: { puppet: string; part: string } | null;
}

export interface PartHit {
  puppet: string;
  part: string;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

interface PuppetNodes {
  group: SVGGElement;
  rod: SVGLineElement;
  parts: Map<string, { group: SVGGElement; path: SVGPathElement; cap: SVGCircleElement }>;
}

export class Stage {
  readonly svg: SVGSVGElement;
  private cast: SVGGElement;
  private dim: SVGRectElement;
  private overlay: SVGGElement;
  private nodes = new Map<string, PuppetNodes>();
  private onHit: ((hit: PartHit | null) => void) | null = null;

  constructor(container: HTMLElement) {
    this.svg = el("svg", { viewBox: `0 0 ${STAGE_W} ${STAGE_H}`, class: "stage", preserveAspectRatio: "xMidYMid meet" });
    this.svg.innerHTML = `${stageDefs()}
      ${stageBackdrop()}
      <g class="cast"></g>
      ${stageForeground(1)}
      <g class="overlay"></g>`;
    this.cast = this.svg.querySelector("g.cast")!;
    this.dim = this.svg.querySelector("rect.dim")!;
    this.overlay = this.svg.querySelector("g.overlay")!;
    container.appendChild(this.svg);
    this.svg.addEventListener("click", (ev) => {
      const g = (ev.target as Element).closest?.("g.part") as SVGGElement | null;
      const pg = g?.closest("g.puppet") as SVGGElement | null;
      if (g && pg) this.onHit?.({ puppet: pg.dataset.id!, part: g.dataset.part! });
      else this.onHit?.(null);
    });
  }

  onPartClick(cb: (hit: PartHit | null) => void) {
    this.onHit = cb;
  }

  /** Rebuild the cast DOM for a new set of puppets. */
  setCast(puppets: Iterable<ResolvedPuppet>) {
    this.cast.innerHTML = "";
    this.nodes.clear();
    for (const p of puppets) {
      const group = el("g", { class: "puppet", "data-id": p.id });
      const rod = el("line", { class: "rod", stroke: INK, "stroke-linecap": "round" });
      group.appendChild(rod);
      const parts = new Map<string, { group: SVGGElement; path: SVGPathElement; cap: SVGCircleElement }>();
      for (const part of p.ordered) {
        const pg = el("g", { class: "part", "data-part": part.id });
        const path = el("path", { d: part.d, fill: INK, "fill-rule": "nonzero" });
        const cap = el("circle", { r: p.cap, fill: INK });
        pg.append(path, cap);
        group.appendChild(pg);
        parts.set(part.id, { group: pg, path, cap });
        if (part.note) {
          const title = el("title");
          title.textContent = `${p.id}/${part.id}${part.note ? " — " + part.note : ""}`;
          pg.appendChild(title);
        }
      }
      this.nodes.set(p.id, { group, rod, parts });
    }
  }

  draw(frame: Frame, opts: DrawOptions) {
    this.dim.setAttribute("opacity", String(1 - Math.max(0, Math.min(1, frame.lamp))));
    // Paint order: append in frame order (far → near), parts by z.
    const seen = new Set<string>();
    for (const fp of frame.puppets) {
      const n = this.nodes.get(fp.puppet.id);
      if (!n) continue;
      seen.add(fp.puppet.id);
      n.group.setAttribute("filter", `url(#blur-${fp.plane})`);
      n.group.setAttribute("opacity", String(fp.opacity));
      n.group.style.display = "";
      this.cast.appendChild(n.group);
      // rod: from the root pivot straight down off the stage
      if (opts.rods) {
        const [rx, ry] = apply(fp.root, [0, 0]);
        n.rod.setAttribute("x1", String(rx)); n.rod.setAttribute("y1", String(ry));
        n.rod.setAttribute("x2", String(rx)); n.rod.setAttribute("y2", String(STAGE_H + 10));
        n.rod.setAttribute("stroke-width", String(2.2 * magnitude(fp.root) * fp.puppet.unit / 100));
        n.rod.style.display = "";
      } else {
        n.rod.style.display = "none";
      }
      for (const part of fp.parts) {
        const pn = n.parts.get(part.part.id)!;
        pn.group.setAttribute("transform", matToString(part.world));
        n.group.appendChild(pn.group);
      }
    }
    for (const [id, n] of this.nodes) if (!seen.has(id)) n.group.style.display = "none";
    this.drawOverlays(frame, opts);
  }

  private drawOverlays(frame: Frame, opts: DrawOptions) {
    const o = opts.overlays;
    const any = o.pivots || o.bounds || o.bboxes || o.caps || opts.selected;
    this.overlay.innerHTML = "";
    if (!any) return;
    for (const fp of frame.puppets) {
      for (const part of fp.parts) {
        const sel = opts.selected && opts.selected.puppet === fp.puppet.id && opts.selected.part === part.part.id;
        if (o.bounds || sel) this.overlay.appendChild(this.boundary(part, !!sel));
        if (o.bboxes) this.overlay.appendChild(this.bbox(part));
        if (o.caps) this.overlay.appendChild(this.capDisc(fp, part));
        if (o.pivots || sel) this.overlay.appendChild(this.pivot(part, !!sel));
      }
    }
  }

  private boundary(part: FramePart, sel: boolean) {
    return el("path", {
      d: part.part.d, transform: matToString(part.world), fill: sel ? "rgba(214,120,40,0.25)" : "none",
      stroke: sel ? "#f0b25a" : "#d67828", "stroke-width": sel ? 2 : 1, "vector-effect": "non-scaling-stroke",
      "pointer-events": "none",
    });
  }
  private bbox(part: FramePart) {
    const b = part.part.bbox;
    const pts = ([[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]] as [number, number][])
      .map((c) => apply(part.world, c)).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    return el("polygon", {
      points: pts, fill: "none", stroke: "#e9d9b4", "stroke-width": 1, "stroke-dasharray": "5 4",
      "vector-effect": "non-scaling-stroke", "pointer-events": "none", opacity: 0.8,
    });
  }
  private capDisc(fp: FramePuppet, part: FramePart) {
    const [x, y] = apply(part.world, [0, 0]);
    return el("circle", {
      cx: x, cy: y, r: fp.puppet.cap * magnitude(part.world), fill: "rgba(140,40,30,0.22)", stroke: "#8c281e",
      "stroke-width": 1, "vector-effect": "non-scaling-stroke", "pointer-events": "none",
    });
  }
  private pivot(part: FramePart, sel: boolean) {
    const g = el("g", { "pointer-events": "none" });
    const m = part.world as Mat;
    const s = magnitude(m) || 1;
    const L = 16 / s;
    const o = apply(m, [0, 0]);
    const px = apply(m, [L, 0]);
    const py = apply(m, [0, L]);
    g.appendChild(el("line", { x1: o[0], y1: o[1], x2: px[0], y2: px[1], stroke: "#d67828", "stroke-width": 1.5 }));
    g.appendChild(el("line", { x1: o[0], y1: o[1], x2: py[0], y2: py[1], stroke: "#8c281e", "stroke-width": 1.5 }));
    g.appendChild(el("circle", { cx: o[0], cy: o[1], r: sel ? 5 : 3.5, fill: "#f7ead0", stroke: "#14100c", "stroke-width": 1 }));
    return g;
  }
}
