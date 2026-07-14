import assert from "node:assert/strict";
import test from "node:test";

import {
  doubleSlitFresnelNumber,
  doubleSlitSmallAngleUncertainty,
  doubleSlitWavelengthSmallAngle,
  finiteDoubleSlitIntensity,
  fitDoubleSlitOrders,
  fitSingleSlitDarkFringes,
  monteCarloWavelength,
  screenSinTheta,
  screenThetaRadians,
  sinc0,
  singleSlitFresnelNumber,
  singleSlitIntensity,
  singleSlitSmallAngleUncertainty,
  singleSlitWavelengthSmallAngle,
  smallAngleSinTheta,
  wavelengthFromExactOrder,
  weightedLinearRegression,
  type ScreenOrderObservation,
} from "../lib/physics.ts";

function assertClose(
  actual: number,
  expected: number,
  relativeTolerance = 1e-12,
  message?: string,
): void {
  const scale = Math.max(Math.abs(actual), Math.abs(expected), Number.MIN_VALUE);
  const relativeError = Math.abs(actual - expected) / scale;
  assert.ok(
    relativeError <= relativeTolerance,
    message ??
      `Expected ${actual} to be within ${relativeTolerance} relative error of ${expected}; got ${relativeError}.`,
  );
}

function screenPositionForSinTheta(
  sinTheta: number,
  screenDistanceM: number,
  centerPositionM = 0,
): number {
  return (
    centerPositionM +
    (screenDistanceM * sinTheta) / Math.sqrt(1 - sinTheta * sinTheta)
  );
}

test("sinc0 implements the removable singularity and stable small-z limit", () => {
  assert.equal(sinc0(0), 1);
  assertClose(sinc0(1e-8), 1 - 1e-16 / 6, 1e-15);
  assertClose(sinc0(Math.PI / 2), 2 / Math.PI, 1e-15);
  assert.ok(Math.abs(sinc0(Math.PI)) < 1e-15);
});

test("screen geometry evaluates sin(atan((x-x0)/L)) exactly", () => {
  const geometry = {
    screenPositionM: 0.35,
    centerPositionM: 0.05,
    screenDistanceM: 0.4,
  };
  assertClose(screenThetaRadians(geometry), Math.atan(0.75), 1e-15);
  assertClose(screenSinTheta(geometry), 0.6, 1e-15);
  assertClose(smallAngleSinTheta(geometry), 0.75, 1e-15);
});

test("single-slit model has its maximum at the axis and zero at the first minimum", () => {
  const wavelengthM = 532e-9;
  const slitWidthM = 0.1e-3;
  const screenDistanceM = 1.2;
  const centerPositionM = 0.004;
  const common = {
    screenDistanceM,
    centerPositionM,
    wavelengthM,
    slitWidthM,
    amplitude: 2,
    background: 0.1,
  };

  assertClose(
    singleSlitIntensity({ ...common, screenPositionM: centerPositionM }),
    2.1,
    1e-15,
  );

  const firstMinimumM = screenPositionForSinTheta(
    wavelengthM / slitWidthM,
    screenDistanceM,
    centerPositionM,
  );
  assertClose(
    singleSlitIntensity({ ...common, screenPositionM: firstMinimumM }),
    0.1,
    1e-13,
  );
});

test("finite-width double-slit model combines cos-squared fringes and sinc-squared envelope", () => {
  const wavelengthM = 650e-9;
  const slitWidthM = 0.04e-3;
  const slitSeparationM = 0.25e-3;
  const screenDistanceM = 1;
  const common = {
    screenDistanceM,
    wavelengthM,
    slitWidthM,
    slitSeparationM,
  };

  assertClose(
    finiteDoubleSlitIntensity({ ...common, screenPositionM: 0 }),
    1,
    1e-15,
  );

  const firstInterferenceMinimumM = screenPositionForSinTheta(
    wavelengthM / (2 * slitSeparationM),
    screenDistanceM,
  );
  assert.ok(
    finiteDoubleSlitIntensity({
      ...common,
      screenPositionM: firstInterferenceMinimumM,
    }) < 1e-28,
  );

  const firstEnvelopeMinimumM = screenPositionForSinTheta(
    wavelengthM / slitWidthM,
    screenDistanceM,
  );
  assert.ok(
    finiteDoubleSlitIntensity({
      ...common,
      screenPositionM: firstEnvelopeMinimumM,
    }) < 1e-28,
  );
});

test("weighted linear regression recovers a known line and honours an intercept", () => {
  const result = weightedLinearRegression([
    { order: -2, sinTheta: -0.005, weight: 1 },
    { order: -1, sinTheta: -0.002, weight: 2 },
    { order: 0, sinTheta: 0.001, weight: 4 },
    { order: 1, sinTheta: 0.004, weight: 3 },
    { order: 2, sinTheta: 0.007, weight: 1 },
  ]);
  assertClose(result.slope, 0.003, 1e-14);
  assertClose(result.intercept, 0.001, 1e-14);
  assert.ok(result.rSquared > 1 - 1e-14);
});

test("exact single-slit dark-fringe regression recovers 532 nm without noise", () => {
  const wavelengthM = 532e-9;
  const slitWidthM = 0.1e-3;
  const screenDistanceM = 1.1;
  const centerPositionM = 0.0025;
  const orders = [-4, -3, -2, -1, 1, 2, 3, 4];
  const observations: ScreenOrderObservation[] = orders.map((order, index) => ({
    order,
    screenPositionM: screenPositionForSinTheta(
      (order * wavelengthM) / slitWidthM,
      screenDistanceM,
      centerPositionM,
    ),
    weight: index + 1,
  }));

  const result = fitSingleSlitDarkFringes({
    observations,
    screenDistanceM,
    slitWidthM,
    centerPositionM,
  });
  assertClose(result.wavelengthM, wavelengthM, 2e-13);
  assert.ok(Math.abs(result.intercept) < 1e-15);
  assert.ok(result.rSquared > 1 - 1e-14);
});

test("exact double-slit maximum regression recovers 650 nm without noise", () => {
  const wavelengthM = 650e-9;
  const slitSeparationM = 0.25e-3;
  const screenDistanceM = 0.95;
  const centerPositionM = -0.001;
  const orders = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
  const observations: ScreenOrderObservation[] = orders.map((order) => ({
    order,
    screenPositionM: screenPositionForSinTheta(
      (order * wavelengthM) / slitSeparationM,
      screenDistanceM,
      centerPositionM,
    ),
    standardUncertaintyM: 5e-6,
  }));

  const result = fitDoubleSlitOrders({
    observations,
    screenDistanceM,
    slitSeparationM,
    centerPositionM,
    fringeType: "maximum",
  });
  assertClose(result.wavelengthM, wavelengthM, 2e-13);
  assert.ok(result.rSquared > 1 - 1e-14);
});

test("double-slit half-integer minimum orders use the same exact regression", () => {
  const wavelengthM = 650e-9;
  const slitSeparationM = 0.25e-3;
  const screenDistanceM = 1;
  const orders = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
  const result = fitDoubleSlitOrders({
    observations: orders.map((order) => ({
      order,
      screenPositionM: screenPositionForSinTheta(
        (order * wavelengthM) / slitSeparationM,
        screenDistanceM,
      ),
    })),
    screenDistanceM,
    slitSeparationM,
    fringeType: "minimum",
  });
  assertClose(result.wavelengthM, wavelengthM, 2e-13);
});

test("exact-order result exposes the finite-angle error in the small-angle approximation", () => {
  const apertureM = 1;
  const screenPositionM = 0.5;
  const screenDistanceM = 1;
  const exactM = wavelengthFromExactOrder({
    apertureM,
    order: 1,
    screenPositionM,
    screenDistanceM,
  });
  const approximateM = smallAngleSinTheta({
    screenPositionM,
    screenDistanceM,
  });
  assertClose(exactM, 1 / Math.sqrt(5), 1e-15);
  assertClose(approximateM, 0.5, 1e-15);
  assertClose(approximateM / exactM - 1, Math.sqrt(5) / 2 - 1, 1e-15);
});

test("small-angle wavelength formulas and Fresnel-number aperture definitions are correct", () => {
  assertClose(
    doubleSlitWavelengthSmallAngle({
      slitSeparationM: 0.25e-3,
      fringeSpacingM: 2.6e-3,
      screenDistanceM: 1,
    }),
    650e-9,
    1e-15,
  );
  assertClose(
    singleSlitWavelengthSmallAngle({
      slitWidthM: 0.1e-3,
      centralMaximumWidthM: 10.64e-3,
      screenDistanceM: 1,
    }),
    532e-9,
    1e-15,
  );
  assertClose(
    singleSlitFresnelNumber({
      slitWidthM: 0.1e-3,
      wavelengthM: 500e-9,
      screenDistanceM: 2,
    }),
    (0.05e-3) ** 2 / (500e-9 * 2),
    1e-15,
  );
  assertClose(
    doubleSlitFresnelNumber({
      slitWidthM: 0.04e-3,
      slitSeparationM: 0.25e-3,
      wavelengthM: 650e-9,
      screenDistanceM: 1,
    }),
    (0.145e-3) ** 2 / 650e-9,
    1e-15,
  );
});

test("first-order propagation uses the independent root-sum-square rule", () => {
  const doubleResult = doubleSlitSmallAngleUncertainty({
    slitSeparationM: { value: 0.25e-3, standardUncertainty: 0.0025e-3 },
    fringeSpacingM: { value: 2.6e-3, standardUncertainty: 0.052e-3 },
    screenDistanceM: { value: 1, standardUncertainty: 0.005 },
  });
  const expectedRelative = Math.sqrt(0.01 ** 2 + 0.02 ** 2 + 0.005 ** 2);
  assertClose(doubleResult.wavelengthM, 650e-9, 1e-15);
  assertClose(doubleResult.relativeStandardUncertainty, expectedRelative, 1e-15);
  assertClose(
    doubleResult.standardUncertaintyM,
    650e-9 * expectedRelative,
    1e-15,
  );

  const singleResult = singleSlitSmallAngleUncertainty({
    slitWidthM: { value: 0.1e-3, standardUncertainty: 1e-6 },
    centralMaximumWidthM: {
      value: 10.64e-3,
      standardUncertainty: 0.1e-3,
    },
    screenDistanceM: { value: 1, standardUncertainty: 0.002 },
  });
  assertClose(singleResult.wavelengthM, 532e-9, 1e-15);
  assert.ok(singleResult.standardUncertaintyM > 0);
});

test("Monte Carlo wavelength intervals are exactly reproducible for a fixed seed", () => {
  const parameters = {
    experiment: "double-slit-small-angle" as const,
    samples: 2_000,
    seed: 20260714,
    confidenceLevel: 0.95,
    slitSeparationM: {
      value: 0.25e-3,
      standardUncertainty: 0.001e-3,
      distribution: "rectangular" as const,
    },
    fringeSpacingM: {
      value: 2.6e-3,
      standardUncertainty: 0.02e-3,
      distribution: "normal" as const,
    },
    screenDistanceM: {
      value: 1,
      standardUncertainty: 0.002,
      distribution: "normal" as const,
    },
  };

  const first = monteCarloWavelength(parameters);
  const second = monteCarloWavelength(parameters);
  assert.deepEqual(second, first);
  assert.ok(first.lowerBoundM < 650e-9);
  assert.ok(first.upperBoundM > 650e-9);
  assert.ok(Math.abs(first.meanM - 650e-9) / 650e-9 < 0.002);

  const differentSeed = monteCarloWavelength({ ...parameters, seed: 20260715 });
  assert.notDeepEqual(differentSeed, first);
});

test("single-slit Monte Carlo path is reproducible and encloses its nominal result", () => {
  const parameters = {
    experiment: "single-slit-small-angle" as const,
    samples: 1_000,
    seed: 532,
    slitWidthM: { value: 0.1e-3, standardUncertainty: 0.001e-3 },
    centralMaximumWidthM: {
      value: 10.64e-3,
      standardUncertainty: 0.05e-3,
    },
    screenDistanceM: { value: 1, standardUncertainty: 0.003 },
  };
  const result = monteCarloWavelength(parameters);
  assert.deepEqual(result, monteCarloWavelength(parameters));
  assert.ok(result.lowerBoundM < 532e-9);
  assert.ok(result.upperBoundM > 532e-9);
});
