import assert from "node:assert/strict";
import test from "node:test";
import { profileIndexForPoint, snapToBrightFringe } from "../lib/fringe-selection.ts";
import { calculateExpression } from "../lib/calculator.ts";

const roi = { centerX: 400, centerY: 200, width: 300, height: 30, angleDeg: 0 };
const peaks = [{ axisPx: -100, position: 100, saturated: false }, { axisPx: 0, position: 200, saturated: true }, { axisPx: 100, position: 300, saturated: false }];

test("bright-fringe snap chooses nearby local center, not a global brightest point", () => {
  const snapped = snapToBrightFringe({ x: 447, y: 203 }, roi, "vertical", peaks, .5, 100)!;
  assert.deepEqual(snapped.point, { x: 450, y: 200 });
  assert.equal(snapped.peak.position, 300);
  assert.equal(snapToBrightFringe({ x: 500, y: 200 }, roi, "vertical", peaks, .5, 100), null);
  assert.equal(snapToBrightFringe({ x: 400, y: 200 }, roi, "vertical", [], 1, 100), null);
});

test("plateau center remains provisional and projected coordinates handle rotated/horizontal profiles", () => {
  assert.equal(snapToBrightFringe({ x: 401, y: 200 }, roi, "vertical", peaks, 1, 100)!.peak.saturated, true);
  const snapped = snapToBrightFringe({ x: 403, y: 249 }, roi, "horizontal", peaks, .5, 100)!;
  assert.ok(Math.abs(snapped.point.x - 400) < 1e-8);
  assert.equal(snapped.point.y, 250);
  assert.equal(profileIndexForPoint(snapped.point, roi, "horizontal", [-200, -100, 0, 100, 200], .5), 3);
  assert.equal(profileIndexForPoint({ x: 425, y: 200 }, roi, "vertical", [-200, -100, 0, 100, 200], .5), 2.5);
  assert.equal(profileIndexForPoint({ x: 700, y: 200 }, roi, "vertical", [-200, 200], .5), null);
});

test("student calculator parses arithmetic, units conversion, precedence and scientific notation", () => {
  assert.equal(calculateExpression("(12 + 8) / 5"), 4);
  assert.ok(Math.abs(calculateExpression("1000 × 0.25 × (90 / 6) ÷ 5.51") - 680.58076225) < 1e-7);
  assert.equal(calculateExpression("2^3^2"), 512);
  assert.equal(calculateExpression("-2^2"), -4);
  assert.equal(calculateExpression("2^-2"), .25);
  assert.equal(calculateExpression("1e-3 * 10^9"), 1e6);
  assert.equal(calculateExpression(".5 + 2."), 2.5);
});

test("calculator rejects zero division, malformed input, scripts and nonfinite results", () => {
  for (const expression of ["", "1/0", "(1+2", "1+", "1..2", "NaN", "Infinity", "alert(1)", "1;2", "10^999", "2".repeat(301)]) assert.throws(() => calculateExpression(expression));
});
