import assert from "node:assert/strict";
import test from "node:test";
import {
  associateOcrNumbers,
  classifyRulerTickLengths,
  clientPointToImagePoint,
  detectPhysicalRuler,
  fitRulerTicksRobust,
  resolveRulerThemeFromSamples,
  snapRulerToDetection,
  snapThresholdPx,
  shouldMarkCalibrationStale,
  validateOcrProgression,
  type DetectedRulerNumber,
  type RulerDetectionResult,
} from "../lib/ruler-detection.ts";
import type { ImageDataLike } from "../lib/signal.ts";

function syntheticRuler(options: {
  body: [number, number, number];
  ink: [number, number, number];
  angleDeg?: number;
  perspective?: number;
  noise?: number;
  missing?: Set<number>;
}): ImageDataLike {
  const width = 720;
  const height = 280;
  const data = new Uint8ClampedArray(width * height * 4);
  const angle = (options.angleDeg ?? 0) * Math.PI / 180;
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const normal = { x: -axis.y, y: axis.x };
  const centre = { x: width / 2, y: height * 0.62 };
  const rulerLength = 620;
  const rulerHeight = 92;
  const pixelsPerMm = 10;
  let seed = 9173;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - centre.x;
      const dy = y - centre.y;
      const u = dx * axis.x + dy * axis.y;
      const v = dx * normal.x + dy * normal.y;
      let color: [number, number, number] = [18, 25, 32];
      if (Math.abs(u) <= rulerLength / 2 && Math.abs(v) <= rulerHeight / 2) {
        color = options.body;
        for (let millimetre = 0; millimetre <= 60; millimetre += 1) {
          if (options.missing?.has(millimetre)) continue;
          const base = -300 + millimetre * pixelsPerMm;
          const warped = base + (options.perspective ?? 0) * (base / 300) ** 2 * 12;
          const tickHeight = millimetre % 10 === 0 ? 45 : millimetre % 5 === 0 ? 31 : 20;
          if (Math.abs(u - warped) <= 1.45 && v >= -rulerHeight / 2 && v <= -rulerHeight / 2 + tickHeight) {
            color = options.ink;
          }
        }
      }
      const noise = ((random() - 0.5) * 2) * (options.noise ?? 0);
      const offset = (y * width + x) * 4;
      data[offset] = Math.max(0, Math.min(255, color[0] + noise));
      data[offset + 1] = Math.max(0, Math.min(255, color[1] + noise));
      data[offset + 2] = Math.max(0, Math.min(255, color[2] + noise));
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

test("adaptive ruler theme chooses dark ink on a bright ruler and double outline on texture", () => {
  const bright = resolveRulerThemeFromSamples([205, 210, 218, 222, 226], "auto");
  assert.equal(bright.resolvedMode, "dark-on-light");
  assert.equal(bright.stroke, "#071019");
  const dark = resolveRulerThemeFromSamples([13, 18, 24, 27, 31], "auto");
  assert.equal(dark.resolvedMode, "light-on-dark");
  const complex = resolveRulerThemeFromSamples([5, 12, 32, 94, 180, 245], "auto");
  assert.equal(complex.complexBackground, true);
  assert.notEqual(complex.stroke, complex.outline);
});

test("robust tick fit tolerates missing ticks and rejects outliers", () => {
  const positions = [20, 30, 40, 60, 70, 80, 90, 101.8, 110, 120, 130, 181.3];
  const fit = fitRulerTicksRobust(positions, 10);
  assert.ok(fit);
  assert.ok(Math.abs(fit.pixelsPerMm - 10) < 0.2);
  assert.ok(fit.missingTickEstimate >= 1);
  assert.ok(fit.inlierCount < fit.totalCount);
  assert.ok(fit.residualRmsPx < 0.6);
});

test("tick length classification retains minor, five and ten millimetre classes", () => {
  const kinds = classifyRulerTickLengths([10, 11, 10, 18, 10, 12, 29, 11, 10, 18, 9]);
  assert.ok(kinds.includes("minor"));
  assert.ok(kinds.includes("medium"));
  assert.ok(kinds.includes("major"));
});

test("OCR anchors associate only near major ticks and progression is validated", () => {
  const ticks = [0, 10, 20, 30].map((millimetreIndex) => ({
    axisPositionPx: 50 + millimetreIndex * 8,
    millimetreIndex,
    kind: "major" as const,
  }));
  const raw = [1, 2, 3].map((value) => ({
    text: String(value),
    value,
    point: { x: 0, y: 0 },
    axisPositionPx: 50 + (value - 1) * 80,
    confidence: 0.8,
  }));
  const associated = associateOcrNumbers(raw, ticks, 12);
  assert.deepEqual(associated.map((item) => item.associatedMillimetreIndex), [0, 10, 20]);
  assert.equal(validateOcrProgression(associated), 1);
  const reversed: DetectedRulerNumber[] = associated.map((item, index) => ({ ...item, value: 3 - index }));
  assert.equal(validateOcrProgression(reversed), 0);
});

test("magnetic threshold follows display scale and remains bounded", () => {
  assert.equal(snapThresholdPx(1), 6);
  assert.equal(snapThresholdPx(0.1), 15);
  assert.equal(snapThresholdPx(4), 3);
});

test("CSS pointer coordinates map to source-image coordinates", () => {
  assert.deepEqual(
    clientPointToImagePoint(
      { x: 260, y: 170 },
      { left: 20, top: 35, width: 480, height: 270 },
      { width: 960, height: 540 },
    ),
    { x: 480, y: 270 },
  );
});

test("physical ruler calibration becomes stale when source geometry changes", () => {
  const signature = {
    sourceType: "image" as const,
    sourceId: "ruler-a.png",
    width: 960,
    height: 540,
    zoom: 1,
    cropKey: "full",
    orientationDeg: 0,
    perspectiveKey: "none",
  };
  assert.equal(shouldMarkCalibrationStale("physical-ruler-overlay", signature, signature), false);
  assert.equal(shouldMarkCalibrationStale("physical-ruler-overlay", signature, { ...signature, sourceId: "ruler-b.png" }), true);
  assert.equal(shouldMarkCalibrationStale("physical-ruler-perspective", signature, { ...signature, perspectiveKey: "h2" }), true);
  assert.equal(shouldMarkCalibrationStale("two-point", signature, { ...signature, zoom: 2 }), false);
});

test("synthetic white, black and yellow rulers recover millimetre scale", () => {
  for (const [body, ink] of [
    [[238, 238, 235], [15, 18, 20]],
    [[25, 28, 31], [235, 240, 242]],
    [[225, 184, 47], [28, 25, 18]],
  ] as Array<[[number, number, number], [number, number, number]]>) {
    const image = syntheticRuler({ body, ink, noise: 3, missing: new Set([7, 18, 34]) });
    const result = detectPhysicalRuler(image, { sourceType: "image" });
    assert.ok(result, `detector should find ruler with body ${body.join(",")}`);
    assert.ok(Math.abs(result.fit.mmPerPixel - 0.1) / 0.1 < 0.01, JSON.stringify({ fit: result.fit, angle: result.angleDeg, region: result.selectedRegion, ticks: result.ticks.slice(0, 16).map((tick) => tick.axisPositionPx) }));
    assert.ok(result.fit.inlierCount >= 20);
  }
});

test("rotated ruler direction is recovered and perspective is reported without claiming correction", () => {
  const image = syntheticRuler({
    body: [240, 240, 238],
    ink: [12, 15, 18],
    angleDeg: 8,
    perspective: 0.9,
    noise: 2,
  });
  const result = detectPhysicalRuler(image, {
    sourceType: "image",
    region: { x: 25, y: 78, width: 670, height: 160 },
  });
  assert.ok(result);
  assert.ok(Math.abs(result.angleDeg - 8) <= 2);
  assert.ok(result.perspectiveVariationPct >= 0);
  assert.equal(result.schema, "fringelab.ruler-detection.v1");
});

test("manual ruler snaps to a nearby detection while Alt disables snapping", () => {
  const image = syntheticRuler({ body: [240, 240, 238], ink: [12, 15, 18] });
  const result = detectPhysicalRuler(image, { sourceType: "image" }) as RulerDetectionResult;
  assert.ok(result);
  const near = {
    start: { x: result.start.x + 3, y: result.start.y + 2 },
    end: { x: result.end.x + 2, y: result.end.y + 2 },
    knownLengthMm: result.ticks.at(-1)!.millimetreIndex,
  };
  const snapped = snapRulerToDetection(near, result, {
    tickSnapEnabled: true,
    numberSnapEnabled: true,
    displayScale: 1,
  });
  assert.equal(snapped.snapped, true);
  const disabled = snapRulerToDetection(near, result, {
    tickSnapEnabled: true,
    numberSnapEnabled: true,
    altKey: true,
  });
  assert.equal(disabled.snapped, false);
});

test("typed ruler result survives session JSON round-trip", () => {
  const image = syntheticRuler({ body: [240, 240, 238], ink: [12, 15, 18] });
  const result = detectPhysicalRuler(image, { sourceType: "image", contrastMode: "auto" });
  assert.ok(result);
  const restored = JSON.parse(JSON.stringify({
    calibrationMethod: "physical-ruler-overlay",
    stale: false,
    rulerDetection: result,
  })) as { calibrationMethod: string; stale: boolean; rulerDetection: RulerDetectionResult };
  assert.equal(restored.calibrationMethod, "physical-ruler-overlay");
  assert.equal(restored.rulerDetection.schema, "fringelab.ruler-detection.v1");
  assert.equal(restored.rulerDetection.ticks.length, result.ticks.length);
  assert.equal(restored.rulerDetection.fit.mmPerPixel, result.fit.mmPerPixel);
});
