import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCalibrationUncertaintyPct,
  calculateMmPerPixel,
  generateRulerTicks,
  hitTestRuler,
  moveRuler,
  resizeRulerEndpoint,
  rulerAngleDeg,
  rulerLengthPx,
  suggestRulerAlignment,
  type RulerCalibration,
} from "../lib/ruler.ts";

const ruler: RulerCalibration = {
  start: { x: 100, y: 100 },
  end: { x: 500, y: 400 },
  knownLengthMm: 50,
};

test("ruler converts a known interval to millimetres per pixel", () => {
  const horizontal = { ...ruler, end: { x: 600, y: 100 } };
  assert.equal(rulerLengthPx(horizontal), 500);
  assert.equal(calculateMmPerPixel(horizontal), 0.1);
  assert.ok(Math.abs((calculateCalibrationUncertaintyPct(horizontal) ?? 0) - 0.141421356) < 1e-6);
});

test("inclined ruler uses Euclidean distance and reports its angle", () => {
  assert.equal(rulerLengthPx(ruler), 500);
  assert.equal(calculateMmPerPixel(ruler), 0.1);
  assert.ok(Math.abs(rulerAngleDeg(ruler) - 36.86989765) < 1e-7);
});

test("moving a ruler preserves its length and known interval", () => {
  const moved = moveRuler(ruler, 20, -15);
  assert.deepEqual(moved.start, { x: 120, y: 85 });
  assert.deepEqual(moved.end, { x: 520, y: 385 });
  assert.equal(rulerLengthPx(moved), rulerLengthPx(ruler));
  assert.equal(moved.knownLengthMm, 50);
});

test("resizing one endpoint anchors the other and supports angle snapping", () => {
  const resized = resizeRulerEndpoint(ruler, "end", { x: 400, y: 130 }, 45);
  assert.deepEqual(resized.start, ruler.start);
  assert.ok(Math.abs(resized.end.y - ruler.start.y) < 1e-9);
  assert.ok(resized.end.x > ruler.start.x);
});

test("ruler ticks distinguish one, five and ten millimetre marks", () => {
  const ticks = generateRulerTicks({
    start: { x: 0, y: 0 },
    end: { x: 500, y: 0 },
    knownLengthMm: 50,
  });
  assert.equal(ticks.length, 51);
  assert.equal(ticks.filter((tick) => tick.kind === "major").length, 6);
  assert.equal(ticks.filter((tick) => tick.kind === "medium").length, 5);
  assert.equal(ticks.filter((tick) => tick.kind === "minor").length, 40);
  assert.deepEqual(ticks[25].point, { x: 250, y: 0 });
});

test("invalid rulers are rejected and handles remain independently hittable", () => {
  assert.equal(calculateMmPerPixel({ ...ruler, knownLengthMm: 0 }), null);
  assert.equal(calculateMmPerPixel({ ...ruler, end: ruler.start }), null);
  assert.equal(calculateMmPerPixel({ ...ruler, knownLengthMm: Number.NaN }), null);
  assert.equal(hitTestRuler(ruler, { x: 102, y: 101 }), "start");
  assert.equal(hitTestRuler(ruler, { x: 300, y: 250 }), "body");
});

test("smart alignment suggests a strong horizontal ruler band without applying scale", () => {
  const width = 640;
  const height = 260;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = y >= 105 && y <= 155 ? 220 : 20;
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const suggestion = suggestRulerAlignment({ width, height, data }, {
    start: { x: 80, y: 108 },
    end: { x: 560, y: 150 },
    knownLengthMm: 50,
  });
  assert.ok(suggestion);
  assert.ok(suggestion.confidence >= 0.8);
  assert.ok(Math.abs(rulerAngleDeg(suggestion.ruler)) < 0.1);
  assert.equal(suggestion.ruler.knownLengthMm, 50);
});
