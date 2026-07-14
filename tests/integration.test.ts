import assert from "node:assert/strict";
import test from "node:test";

import { fitDoubleSlitOrders, fitSingleSlitDarkFringes } from "../lib/physics.ts";
import {
  detectPeaks,
  detectTroughs,
  extractStripProfile,
  gaussianSmooth,
  subtractBackground,
} from "../lib/signal.ts";
import { simulateDiffraction } from "../lib/simulator.ts";

const roi = { centerX: 480, centerY: 270, width: 820, height: 116, angleDeg: 0 };
const millimetresPerPixel = 0.02;
const screenDistanceM = 1.5;

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(fraction * (sorted.length - 1))];
}

function processedProfile(kind: "single-slit" | "double-slit", wavelengthNm: number, slitWidthMm: number) {
  const simulation = simulateDiffraction({
    kind,
    width: 960,
    height: 540,
    wavelengthNm,
    slitWidthMm,
    slitSeparationMm: 0.25,
    screenDistanceM,
    mmPerPixel: millimetresPerPixel,
    noiseStd: 0.012,
    gamma: 1,
    saturationLevel: 0.96,
    background: 0.012,
    seed: kind === "double-slit" ? 2026 : 2027,
  });
  const extracted = extractStripProfile(simulation.frame, {
    channel: "auto",
    fringeOrientation: "vertical",
    roi,
  });
  const background = percentile(Array.from(extracted.profile), 0.03);
  const corrected = subtractBackground(extracted.profile, background, true);
  return {
    selectedChannel: extracted.selectedChannel,
    profile: gaussianSmooth(corrected, 1.8),
    axisPx: extracted.axisPositionsPx,
  };
}

test("camera-like double-slit pipeline recovers 650 nm within two percent", () => {
  const { profile, axisPx, selectedChannel } = processedProfile("double-slit", 650, 0.04);
  const peaks = detectPeaks(profile, {
    minProminence: 1.5,
    minDistance: 100,
    maxPeaks: 5,
    plateauTolerance: 0.0001,
  });
  assert.equal(peaks.length, 3);
  assert.equal(selectedChannel, "g", "auto mode should avoid the saturated red channel");

  const observations = peaks.map((peak, index) => ({
    order: index - 1,
    screenPositionM: axisPx[Math.round(peak.position)] * millimetresPerPixel / 1e3,
  }));
  const result = fitDoubleSlitOrders({
    observations,
    screenDistanceM,
    slitSeparationM: 0.25e-3,
    centerPositionM: observations[1].screenPositionM,
  });
  const measuredNm = result.wavelengthM * 1e9;
  assert.ok(Math.abs(measuredNm - 650) / 650 < 0.02, `measured ${measuredNm} nm`);
});

test("camera-like single-slit pipeline recovers 532 nm within two percent", () => {
  const { profile, axisPx } = processedProfile("single-slit", 532, 0.12);
  const troughs = detectTroughs(profile, {
    minProminence: 0.2,
    minDistance: 20,
    maxPeaks: 4,
    plateauTolerance: 0.0001,
  });
  assert.equal(troughs.length, 2);

  const observations = troughs.map((trough, index) => ({
    order: index === 0 ? -1 : 1,
    screenPositionM: axisPx[Math.round(trough.position)] * millimetresPerPixel / 1e3,
  }));
  const centerPositionM = (observations[0].screenPositionM + observations[1].screenPositionM) / 2;
  const result = fitSingleSlitDarkFringes({
    observations,
    screenDistanceM,
    slitWidthM: 0.12e-3,
    centerPositionM,
  });
  const measuredNm = result.wavelengthM * 1e9;
  assert.ok(Math.abs(measuredNm - 532) / 532 < 0.02, `measured ${measuredNm} nm`);
});
