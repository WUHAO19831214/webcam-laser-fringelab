import assert from "node:assert/strict";
import test from "node:test";
import { calculateFringeExercise, checkExerciseAnswer } from "../lib/lesson.ts";
import { suggestFringeRoi } from "../lib/image-quality.ts";

test("teaching calculation counts intervals and converts mm to nm", () => {
  const result = calculateFringeExercise([{ x: 0, y: 10 }, { x: 350, y: 10 }], 5, .2, 0, .25, 5.510)!;
  assert.equal(result.spanMm, 70);
  assert.equal(result.spacingMm, 14);
  assert.ok(Math.abs(result.wavelengthNm - 635.2087) < .001);
  assert.equal(checkExerciseAnswer("14", result.spacingMm), "correct");
  assert.equal(checkExerciseAnswer("11.67", result.spacingMm), "retry");
  assert.equal(checkExerciseAnswer("", result.spacingMm), "empty");
  assert.equal(checkExerciseAnswer("NaN", result.spacingMm), "invalid");
  assert.equal(calculateFringeExercise([{ x: 0, y: 0 }, { x: 100, y: 0 }], 2.5, .2, 0, .25, 5.51), null);
});

test("student span uses the applied local ruler, including rotated axes", () => {
  const anchors = [{ x: 0, y: 20, mm: 0 }, { x: 100, y: 20, mm: 10 }, { x: 220, y: 20, mm: 20 }];
  const result = calculateFringeExercise([{ x: 50, y: 0 }, { x: 160, y: 0 }], 2, .1, 0, .25, 5, anchors)!;
  assert.equal(result.spanMm, 10);
  assert.equal(result.spacingMm, 5);
  const rotated = calculateFringeExercise([{ x: 20, y: 0 }, { x: 20, y: 100 }], 2, .1, 90, .25, 5)!;
  assert.equal(rotated.spanMm, 10);
});

test("ROI suggestion locates coloured fringes rather than monochrome ruler ticks and never edits pixels", () => {
  const width = 640, height = 360;
  const data = new Uint8ClampedArray(width * height * 4).fill(220);
  for (let y = 80; y < 110; y++) for (let x = 80; x < 560; x++) data.set([255, 70 + Math.round(30 * Math.cos(x / 8)), 80, 255], (y * width + x) * 4);
  for (let y = 220; y < 270; y++) for (let x = 80; x < 560; x++) if (x % 10 < 2) data.set([0, 0, 0, 255], (y * width + x) * 4);
  const copy = data.slice();
  const roi = suggestFringeRoi({ width, height, data })!;
  assert.ok(roi.centerY >= 120 && roi.centerY <= 165);
  assert.equal(roi.height, 24);
  assert.deepEqual(data, copy);
  assert.equal(suggestFringeRoi({ width: 100, height: 100, data: new Uint8ClampedArray(40000).fill(180) }), null);
});
