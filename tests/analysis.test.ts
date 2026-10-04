import assert from "node:assert/strict";
import test from "node:test";
import { analyseFrame, type AnalysisConfig } from "../lib/analysis.ts";
import { mapScreenPointMm, validateSpatialAnchors } from "../lib/spatial.ts";
import { extractStripProfile } from "../lib/signal.ts";

function redFringes() {
  const width = 640; const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const distance = ((x - 40 + 35) % 70 + 70) % 70 - 35;
    const signal = Math.exp(-(distance ** 2) / (2 * 12 ** 2));
    const offset = (y * width + x) * 4;
    data.set([Math.min(255, 180 + 100 * signal), 210 - 90 * signal, 200 - 50 * signal, 255], offset);
  }
  return { width, height, data };
}

const config: AnalysisConfig = { experiment: "double", channel: "auto", orientation: "vertical", roi: { centerX: 320, centerY: 12, width: 570, height: 24, angleDeg: 0 }, mmPerPixel: .2, screenDistanceM: 5.510, slitWidthMm: .04, slitSeparationMm: .25, apertureUncertaintyMm: .002, distanceUncertaintyM: .005, calibrationUncertaintyPct: 1, referenceWavelengthNm: 650, hasReference: false, slitWidthKnown: false, smoothingSigma: 1.8, background: null };

test("red fringes on a white screen never select inverted green maxima", () => {
  const extracted = extractStripProfile(redFringes(), { channel: "auto", roi: config.roi });
  assert.equal(extracted.selectedChannel, "r");
  assert.equal(extracted.laserColor, "r");
  assert.ok(extracted.saturationRates.r > .1);
});

test("raw clipping survives subtraction and invalidates peak widths, not provisional positions", () => {
  const analysis = analyseFrame(redFringes(), { ...config, background: Array(570).fill(180) });
  assert.ok(Math.max(...analysis.smooth) < 100);
  assert.ok(analysis.saturationRate > .1);
  assert.ok(analysis.peaks.filter((peak) => peak.saturated).length >= 5);
  assert.ok(analysis.peaks.filter((peak) => peak.saturated).every((peak) => peak.width === null));
  assert.equal(analysis.provisional, true);
  assert.equal(analysis.uncertaintyNm, null);
  assert.equal(analysis.referenceErrorPct, null);
  assert.equal(analysis.fresnelNumber, null);
  assert.ok(Math.abs(analysis.wavelengthNm! - .25 * 14 / 5.510 * 1000) < 3);
  assert.ok(analysis.smallAngleDifferencePct! < .01);
});

test("unconfirmed data or stale calibration blocks physical measurement", () => {
  const analysis = analyseFrame(redFringes(), { ...config, measurementReady: false });
  assert.equal(analysis.wavelengthNm, null);
  assert.equal(analysis.fringeSpacingMm, null);
  assert.equal(analysis.referenceErrorPct, null);
  assert.match(analysis.status, /待确认/);
  assert.ok(analysis.raw.length > 0);
});

test("multi-point ruler maps a changing local scale rather than one global scale", () => {
  const anchors = [{ x: 20, y: 50, mm: 0 }, { x: 120, y: 50, mm: 10 }, { x: 240, y: 50, mm: 20 }];
  assert.equal(validateSpatialAnchors(anchors).valid, true);
  assert.ok(validateSpatialAnchors(anchors).variationPct > 15);
  assert.equal(mapScreenPointMm({ x: 70, y: 10 }, anchors), 5);
  assert.equal(mapScreenPointMm({ x: 180, y: 10 }, anchors), 15);
  assert.equal(validateSpatialAnchors(anchors.slice(0, 2)).valid, false);
  assert.equal(validateSpatialAnchors([{ x: 0, y: 0, mm: 0 }, { x: 60, y: 45, mm: 10 }, { x: 100, y: 0, mm: 20 }]).valid, false);
});

test("explicitly supplied slit width enables the model without an unknown-width warning", () => {
  const analysis = analyseFrame(redFringes(), { ...config, slitWidthKnown: true, slitWidthMm: .04 });
  assert.ok(analysis.fresnelNumber != null);
  assert.ok(!analysis.warnings.some((warning) => warning.includes("缝宽 a 未知")));
});
