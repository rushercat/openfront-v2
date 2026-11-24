// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DocumentEditor } from "../../../src/client/scenario/DocumentEditor";
import {
  land,
  newScenarioDocument,
  WATER,
} from "../../../src/client/scenario/ScenarioDocument";
import {
  landElevation,
  SlopeStroke,
  TerrainStroke,
} from "../../../src/client/scenario/TerrainBrush";

const W = 100;
const H = 100;

function flatLand() {
  const doc = newScenarioDocument("slopes", W, H);
  doc.terrain.fill(land(0));
  return { doc, editor: new DocumentEditor(doc, () => {}) };
}

const at = (x: number, y: number) => y * W + x;

describe("SlopeStroke", () => {
  it("paints the brush at full height and slopes around it", () => {
    const { doc, editor } = flatLand();
    const stroke = new SlopeStroke(editor, 20, 2, 8);
    stroke.moveTo(50, 50);
    expect(stroke.end()).toBe(true);

    expect(doc.terrain[at(50, 50)]).toBe(land(20));
    expect(doc.terrain[at(52, 50)]).toBe(land(20));
    // Falls off with distance.
    const heights = [53, 55, 57, 59].map(
      (x) => landElevation(doc.terrain[at(x, 50)])!,
    );
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeLessThanOrEqual(heights[i - 1]);
    }
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights[0]).toBeLessThan(20);
    // Beyond the slope nothing changes.
    expect(doc.terrain[at(62, 50)]).toBe(land(0));
  });

  it("never lowers a higher mountain and leaves water alone", () => {
    const { doc, editor } = flatLand();
    doc.terrain[at(55, 50)] = land(30);
    doc.terrain[at(45, 50)] = WATER;
    const stroke = new SlopeStroke(editor, 20, 2, 8);
    stroke.moveTo(50, 50);
    stroke.end();
    expect(doc.terrain[at(55, 50)]).toBe(land(30));
    expect(doc.terrain[at(45, 50)]).toBe(WATER);
  });

  it("keeps the higher slope where two strokes overlap", () => {
    const { doc, editor } = flatLand();
    const first = new SlopeStroke(editor, 25, 1, 10);
    first.moveTo(40, 50);
    first.end();
    const before = landElevation(doc.terrain[at(46, 50)])!;
    const second = new SlopeStroke(editor, 10, 1, 4);
    second.moveTo(48, 50);
    second.end();
    expect(landElevation(doc.terrain[at(46, 50)])!).toBeGreaterThanOrEqual(
      before,
    );
  });

  it("slopes stay ordinary land that a brush can paint over", () => {
    const { doc, editor } = flatLand();
    const slope = new SlopeStroke(editor, 20, 2, 8);
    slope.moveTo(50, 50);
    slope.end();
    const flat = new TerrainStroke(editor, land(2), 0);
    flat.moveTo(55, 50);
    flat.end();
    expect(doc.terrain[at(55, 50)]).toBe(land(2));
  });

  it("follows the stroke along a line", () => {
    const { doc, editor } = flatLand();
    const stroke = new SlopeStroke(editor, 15, 1, 5);
    stroke.moveTo(20, 30);
    stroke.moveTo(60, 30);
    stroke.end();
    for (const x of [20, 40, 60]) {
      expect(doc.terrain[at(x, 30)]).toBe(land(15));
      expect(landElevation(doc.terrain[at(x, 33)])!).toBeGreaterThan(0);
    }
  });
});
