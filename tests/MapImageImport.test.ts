import { fitMapSize } from "../src/client/scenario/ImageImport";
import { isScenarioSize } from "../src/client/scenario/ScenarioDocument";

describe("map editor image import", () => {
  test("a map size keeps the image's shape within the editor's limits", () => {
    const wide = fitMapSize(4000, 1000);
    expect(wide).toEqual({ width: 2000, height: 500 });
    expect(isScenarioSize(wide.width, wide.height)).toBe(true);

    // Small images grow to the minimum side; sides are multiples of 4.
    const small = fitMapSize(50, 30);
    expect(small.height).toBe(100);
    // An image that fits keeps its size.
    expect(fitMapSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(small.width % 4).toBe(0);
    expect(isScenarioSize(small.width, small.height)).toBe(true);

    const odd = fitMapSize(1234, 987, 1500);
    expect(odd.width % 4).toBe(0);
    expect(odd.height % 4).toBe(0);
    expect(Math.max(odd.width, odd.height)).toBeLessThanOrEqual(1500);
  });
});
