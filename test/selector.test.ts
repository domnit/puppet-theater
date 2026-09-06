import { describe, expect, test } from "bun:test";
import {
  SelectorError, formatSelector, hasWildcard, parseSelector, resolve, resolveAll, resolveValue, scopeSteps,
  type Scope,
} from "../src/doc/selector";
import { loadPlay } from "./helpers";

/** Every form the spec and the brief spell out. */
const FORMS = [
  "s1", "s1/b4", "s1/b4:fox", "s1/b4:fox@0", "s1/b4:fox@0.6", "s1/b4:fox@*",
  "s1/b4:fox@0.joints.arm_l", "s1/b4:fox@*.root.x", "s1/b4.fx", "s1/b4.fx@0.5",
  "s1/b4.label", "s1/b4.length", "s1.title", "scenes", "s1/beats",
  "cast", "cast.fox", "cast.fox.parts", "cast.fox.parts.snout", "cast.fox.parts.snout.path",
  "cast.fox.restPose.head", "cast.fox.note", "cast.fox.unit", "cast.fox.look.idle",
  "title", "stage.tempo", "stage.backdrop", "mode", "meta.remixOf",
];

describe("grammar", () => {
  test("every form round-trips through formatSelector", () => {
    for (const sel of FORMS) expect(formatSelector(parseSelector(sel))).toBe(sel);
  });

  test("the first segment is a scene id unless it is a reserved word", () => {
    expect(parseSelector("s1")[0]).toEqual({ kind: "scene", id: "s1" });
    expect(parseSelector("stage.tempo")[0]).toEqual({ kind: "prop", name: "stage" });
    expect(parseSelector("s1/beats")[1]).toEqual({ kind: "prop", name: "beats" });
    expect(parseSelector("s1/b4")[1]).toEqual({ kind: "beat", id: "b4" });
  });

  test("after @ the number is read greedily, so the next dot starts a property", () => {
    expect(parseSelector("s1/b4.fx@0.5.to").slice(3)).toEqual([
      { kind: "key", at: 0.5 }, { kind: "prop", name: "to" },
    ]);
    expect(parseSelector("s1/b4:fox@0.joints.head").slice(3)).toEqual([
      { kind: "key", at: 0 }, { kind: "prop", name: "joints" }, { kind: "prop", name: "head" },
    ]);
  });

  test("@* is a wildcard over a whole track", () => {
    expect(hasWildcard(parseSelector("s1/b4:fox@*.joints.head"))).toBe(true);
    expect(hasWildcard(parseSelector("s1/b4:fox@0.joints.head"))).toBe(false);
  });

  const bad = (sel: string, re: RegExp, scope?: Scope) => {
    expect(() => parseSelector(sel, scope)).toThrow(SelectorError);
    try {
      parseSelector(sel, scope);
    } catch (e) {
      expect((e as Error).message).toMatch(re);
    }
  };

  test("malformed selectors are rejected", () => {
    bad("s1//b4", /empty step/);
    bad("s1?b4", /unexpected/);
    bad("s1/b4/x", /does not follow/);
    bad("s1/b4:fox.pose", /does not follow/);
    bad("s1/b4:fox@x", /empty step/);
  });
});

describe("scopes", () => {
  test("a scope prefixes every selector parsed inside it", () => {
    expect(scopeSteps({ kind: "scene", id: "s3" })).toEqual([{ kind: "scene", id: "s3" }]);
    expect(formatSelector(parseSelector("b4:fox@*.joints.head", { kind: "scene", id: "s3" })))
      .toBe("s3/b4:fox@*.joints.head");
    expect(formatSelector(parseSelector("parts.snout.path", { kind: "cast", puppet: "fox" })))
      .toBe("cast.fox.parts.snout.path");
    expect(formatSelector(parseSelector("fox.note", { kind: "cast" }))).toBe("cast.fox.note");
  });

  test("a selector that already spells out its own prefix is forgiven", () => {
    expect(formatSelector(parseSelector("s3/b4", { kind: "scene", id: "s3" }))).toBe("s3/b4");
    expect(formatSelector(parseSelector("cast.fox.parts", { kind: "cast", puppet: "fox" }))).toBe("cast.fox.parts");
    expect(formatSelector(parseSelector("fox.parts", { kind: "cast", puppet: "fox" }))).toBe("cast.fox.parts");
    expect(formatSelector(parseSelector("cast.fox", { kind: "cast" }))).toBe("cast.fox");
  });

  test("an empty selector addresses the scope root", () => {
    expect(parseSelector("", { kind: "play" })).toEqual([]);
    expect(formatSelector(parseSelector("", { kind: "scene", id: "s3" }))).toBe("s3");
    expect(formatSelector(parseSelector("", { kind: "cast", puppet: "fox" }))).toBe("cast.fox");
    expect(formatSelector(parseSelector("", { kind: "cast" }))).toBe("cast");
  });

  test("a selector may not escape its scope", () => {
    expect(() => parseSelector("s2/b1", { kind: "scene", id: "s3" })).toThrow(/escapes scene s3/);
    expect(() => parseSelector("cast.heron.note", { kind: "cast", puppet: "fox" })).toThrow(/escapes cast fox/);
  });
});

const play = await loadPlay("fixtures/plays/04-lantern.json");

describe("navigation", () => {
  const at = (sel: string) => resolveValue(play, parseSelector(sel));

  test("resolve walks to a value", () => {
    expect(at("s1/b7.label")).toBe("he stops and lifts the lantern");
    expect(at("s1/b7:keeper@0.6.joints.arm_near")).toBe(-100);
    expect(at("s1/b9.fx@0.5.to")).toBe(0.3);
    expect((at("cast.keeper.parts") as unknown[]).length).toBeGreaterThan(3);
    expect(at("stage.tempo")).toBe(96);
  });

  test("a slot names the container, the key and what is there", () => {
    const slot = resolve(play, parseSelector("s1/b7:keeper@0.6"));
    expect(slot.by).toBe("at");
    expect(slot.at).toBe(0.6);
    expect(Array.isArray(slot.parent)).toBe(true);
    const beat = resolve(play, parseSelector("s1/b7"));
    expect(beat.by).toBe("id");
    expect((beat.value as { id: string }).id).toBe("b7");
  });

  test("an absent last step resolves to a slot with no value, an absent path does not", () => {
    expect(resolve(play, parseSelector("s1/b99")).value).toBeUndefined();
    expect(resolve(play, parseSelector("s1/b7:keeper@0.joints.nose")).value).toBeUndefined();
    expect(() => resolveAll(play, parseSelector("s1/b99:keeper@0"))).toThrow(SelectorError);
  });

  test("@* resolves to one slot per keyframe", () => {
    const slots = resolveAll(play, parseSelector("s1/b7:keeper@*"));
    expect(slots.map((s) => s.at)).toEqual([0, 0.6]);
    expect(() => resolve(play, parseSelector("s1/b7:keeper@*"))).toThrow(/not one/);
  });

  test("resolving never mutates the document", () => {
    const before = JSON.stringify(play);
    resolveValue(play, parseSelector("s1/b7:keeper@0.root.x"));
    expect(() => resolveAll(play, parseSelector("s1/b8:keeper@0.root.x"))).toThrow(SelectorError);
    expect(JSON.stringify(play)).toBe(before);
  });
});
