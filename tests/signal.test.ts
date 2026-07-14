import assert from "node:assert/strict";
import { test } from "node:test";

// Explicit .ts URLs let this suite run directly on Node 22's built-in type
// stripping, while the erased type imports preserve strict API checking.
import type * as SignalApi from "../lib/signal";
import type * as SimulatorApi from "../lib/simulator";

const signal = await import(new URL("../lib/signal.ts", import.meta.url).href) as typeof SignalApi;
const simulator = await import(new URL("../lib/simulator.ts", import.meta.url).href) as typeof SimulatorApi;

const {
  calculateFwhm,
  detectPeaks,
  estimatePeriod,
  extractStripProfile,
  gaussianSmooth,
  movingAverageSmooth,
  subtractBackground,
} = signal;
const { simulateDiffraction } = simulator;

function assertClose(actual: number, expected: number, tolerance: number, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message ?? `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test("Gaussian peak gets a subpixel centre and interpolated FWHM", () => {
  const centre = 40.35;
  const sigma = 4;
  const profile = Float64Array.from({ length: 91 }, (_, index) => (
    180 * Math.exp(-((index - centre) ** 2) / (2 * sigma ** 2))
  ));

  const peaks = detectPeaks(profile, { minProminence: 100, minDistance: 5 });
  assert.equal(peaks.length, 1);
  assertClose(peaks[0].position, centre, 0.03);

  const width = calculateFwhm(profile, peaks[0].index);
  assert.ok(width);
  assertClose(width.width, 2 * Math.sqrt(2 * Math.log(2)) * sigma, 0.08);
});

test("plateau peaks carry plateau and saturation flags", () => {
  const peaks = detectPeaks([0, 80, 220, 255, 255, 220, 80, 0], {
    minProminence: 100,
    saturationThreshold: 250,
  });
  assert.equal(peaks.length, 1);
  assert.equal(peaks[0].plateau, true);
  assert.equal(peaks[0].plateauSize, 2);
  assert.equal(peaks[0].position, 3.5);
  assert.equal(peaks[0].saturated, true);
});

test("smoothing functions retain length and moving average has defined edges", () => {
  const impulse = [0, 0, 1, 0, 0];
  const gaussian = gaussianSmooth(impulse, 1);
  const moving = movingAverageSmooth(impulse, 3);
  assert.equal(gaussian.length, impulse.length);
  assert.equal(moving.length, impulse.length);
  assert.ok(gaussian[2] > gaussian[1]);
  assert.deepEqual(Array.from(moving), [0, 1 / 3, 1 / 3, 1 / 3, 0]);
});

test("background subtraction stays floating point and preserves negative noise", () => {
  assert.deepEqual(
    Array.from(subtractBackground(new Uint8Array([7, 10, 13]), 10)),
    [-3, 0, 3],
  );
  assert.deepEqual(
    Array.from(subtractBackground([7, 10, 13], [8, 8, 15])),
    [-1, 2, -2],
  );
  assert.deepEqual(
    Array.from(subtractBackground([7, 10, 13], 10, true)),
    [0, 0, 3],
  );
});

test("strip extraction averages along fringes and auto-selects an unsaturated high-contrast channel", () => {
  const width = 32;
  const height = 6;
  const data = new Uint8ClampedArray(width * height * 4);
  const expectedGreen = new Float64Array(width);
  for (let x = 0; x < width; x += 1) {
    expectedGreen[x] = Math.round(15 + 190 * Math.exp(-((x - 15.4) ** 2) / (2 * 4 ** 2)));
    for (let y = 0; y < height; y += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 255; // deliberately unusable saturated red channel
      data[offset + 1] = expectedGreen[x];
      data[offset + 2] = 6;
      data[offset + 3] = 255;
    }
  }

  const result = extractStripProfile({ width, height, data }, {
    channel: "auto",
    fringeOrientation: "vertical",
  });
  assert.equal(result.selectedChannel, "g");
  assert.equal(result.axis, "x");
  assert.equal(result.profile.length, width);
  assert.equal(result.saturationRates.r, 1);
  assert.equal(result.saturationRates.g, 0);
  assert.deepEqual(Array.from(result.profile), Array.from(expectedGreen));
  assert.ok(Array.from(result.samplesPerBin).every((count) => count === height));
});

test("650 nm double-slit simulation reproduces its expected fringe spacing", () => {
  const simulation = simulateDiffraction({
    kind: "double-slit",
    wavelengthNm: 650,
    slitWidthMm: 0.02,
    slitSeparationMm: 0.25,
    screenDistanceM: 1,
    mmPerPixel: 0.05,
    width: 521,
    height: 24,
    gamma: 1,
    noiseStd: 0,
    saturationLevel: 1,
    seed: 2026,
  });

  assert.equal(simulation.expectedFringeSpacingMm, 2.6);
  assertClose(simulation.exactFirstOrderDisplacementMm ?? 0, 2.6, 0.0001);

  const extracted = extractStripProfile(simulation.frame, {
    channel: "r",
    fringeOrientation: "vertical",
    saturationThreshold: 256,
  });
  const peaks = detectPeaks(extracted.profile, {
    minProminence: 80,
    minDistance: 40,
    saturationThreshold: 256,
  });
  const centre = simulation.parameters.centerX;
  const centralPeak = peaks.reduce((nearest, peak) => (
    Math.abs(peak.position - centre) < Math.abs(nearest.position - centre) ? peak : nearest
  ));
  const rightPeak = peaks.find((peak) => peak.position > centralPeak.position + 30);
  assert.ok(rightPeak, "expected a first-order peak to the right of centre");
  assertClose(rightPeak.position - centralPeak.position, 52, 0.5);

  const period = estimatePeriod(simulation.truthProfile, { minLag: 35, maxLag: 70 });
  assert.ok(period !== null);
  assertClose(period, 52, 1);
});

test("camera noise is reproducible for a fixed seed", () => {
  const options = {
    kind: "single-slit" as const,
    width: 40,
    height: 12,
    noiseStd: 0.02,
    seed: 42,
  };
  const first = simulateDiffraction(options);
  const second = simulateDiffraction(options);
  const different = simulateDiffraction({ ...options, seed: 43 });
  assert.deepEqual(first.frame.data, second.frame.data);
  assert.notDeepEqual(first.frame.data, different.frame.data);
});
