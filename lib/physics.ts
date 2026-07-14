/**
 * Dependency-free Fraunhofer diffraction/interference calculations.
 *
 * Unit contract: every length passed to or returned from this module is in
 * metres (m), angles are in radians, and intensity values are relative values.
 */

export type Metres = number;

export interface ScreenGeometry {
  /** Coordinate on the screen plane, in metres. */
  screenPositionM: Metres;
  /** Slit-plane to screen-plane distance, in metres. Must be > 0. */
  screenDistanceM: Metres;
  /** Optical-axis coordinate on the screen, in metres. Defaults to 0. */
  centerPositionM?: Metres;
}

export interface RelativeIntensityModel {
  /** Peak signal scale in arbitrary units. Defaults to 1. */
  amplitude?: number;
  /** Constant background in arbitrary units. Defaults to 0. */
  background?: number;
  /** Linear background gradient in arbitrary units per metre. Defaults to 0. */
  backgroundSlopePerM?: number;
}

export interface SingleSlitIntensityParameters
  extends ScreenGeometry,
    RelativeIntensityModel {
  wavelengthM: Metres;
  slitWidthM: Metres;
}

export interface FiniteDoubleSlitIntensityParameters
  extends ScreenGeometry,
    RelativeIntensityModel {
  wavelengthM: Metres;
  /** Width of each slit, in metres. */
  slitWidthM: Metres;
  /** Centre-to-centre separation of the two slits, in metres. */
  slitSeparationM: Metres;
  /** Fringe visibility, from 0 to 1. Defaults to 1. */
  visibility?: number;
  /** Fixed phase offset, in radians. Defaults to 0. */
  phaseRadians?: number;
}

export interface RegressionPoint {
  order: number;
  sinTheta: number;
  /** Positive relative statistical weight. Defaults to 1. */
  weight?: number;
}

export interface WeightedLinearRegressionResult {
  /** Slope in sin(theta) per fringe order. */
  slope: number;
  intercept: number;
  slopeStandardError: number | null;
  interceptStandardError: number | null;
  residualStandardError: number | null;
  rSquared: number;
  weightedSumSquaredResiduals: number;
  degreesOfFreedom: number;
  residuals: readonly number[];
}

export interface ScreenOrderObservation {
  /** Integer for single-slit minima/double-slit maxima; half-integer for double-slit minima. */
  order: number;
  /** Measured coordinate on the screen plane, in metres. */
  screenPositionM: Metres;
  /** Explicit relative weight. Cannot be combined with standardUncertaintyM. */
  weight?: number;
  /** Standard uncertainty of screenPositionM, in metres. */
  standardUncertaintyM?: Metres;
}

export interface WavelengthRegressionResult
  extends WeightedLinearRegressionResult {
  wavelengthM: Metres;
  wavelengthStandardErrorM: Metres | null;
  transformedPoints: readonly RegressionPoint[];
}

export interface SingleSlitRegressionParameters {
  observations: readonly ScreenOrderObservation[];
  screenDistanceM: Metres;
  slitWidthM: Metres;
  centerPositionM?: Metres;
}

export type DoubleSlitFringeType = "maximum" | "minimum";

export interface DoubleSlitRegressionParameters {
  observations: readonly ScreenOrderObservation[];
  screenDistanceM: Metres;
  slitSeparationM: Metres;
  centerPositionM?: Metres;
  /** Maxima use integer orders; minima use half-integer orders. Defaults to maximum. */
  fringeType?: DoubleSlitFringeType;
}

export interface ExactOrderWavelengthParameters extends ScreenGeometry {
  /** Known slit width a or centre separation d, in metres. */
  apertureM: Metres;
  /** Non-zero diffraction/interference order (half-integers are allowed). */
  order: number;
}

export interface DoubleSlitSmallAngleParameters {
  slitSeparationM: Metres;
  fringeSpacingM: Metres;
  screenDistanceM: Metres;
}

export interface SingleSlitSmallAngleParameters {
  slitWidthM: Metres;
  /** Distance between the two first minima around the central maximum, in metres. */
  centralMaximumWidthM: Metres;
  screenDistanceM: Metres;
}

export interface FresnelNumberSingleSlitParameters {
  slitWidthM: Metres;
  wavelengthM: Metres;
  screenDistanceM: Metres;
}

export interface FresnelNumberDoubleSlitParameters
  extends FresnelNumberSingleSlitParameters {
  slitSeparationM: Metres;
}

export interface ScalarMeasurement {
  value: number;
  /** One-standard-deviation uncertainty, in the same unit as value. */
  standardUncertainty: number;
}

export interface WavelengthUncertaintyResult {
  wavelengthM: Metres;
  standardUncertaintyM: Metres;
  relativeStandardUncertainty: number;
}

export interface DoubleSlitSmallAngleUncertaintyParameters {
  slitSeparationM: ScalarMeasurement;
  fringeSpacingM: ScalarMeasurement;
  screenDistanceM: ScalarMeasurement;
}

export interface SingleSlitSmallAngleUncertaintyParameters {
  slitWidthM: ScalarMeasurement;
  centralMaximumWidthM: ScalarMeasurement;
  screenDistanceM: ScalarMeasurement;
}

export type MonteCarloDistribution = "normal" | "rectangular";

export interface MonteCarloMeasurement extends ScalarMeasurement {
  /**
   * `rectangular` uses a half-width of sqrt(3) * standardUncertainty, so the
   * supplied uncertainty has the same standard-deviation meaning in both modes.
   */
  distribution?: MonteCarloDistribution;
}

interface MonteCarloCommonParameters {
  samples?: number;
  seed?: number;
  confidenceLevel?: number;
  screenDistanceM: MonteCarloMeasurement;
}

export interface DoubleSlitMonteCarloParameters
  extends MonteCarloCommonParameters {
  experiment: "double-slit-small-angle";
  slitSeparationM: MonteCarloMeasurement;
  fringeSpacingM: MonteCarloMeasurement;
}

export interface SingleSlitMonteCarloParameters
  extends MonteCarloCommonParameters {
  experiment: "single-slit-small-angle";
  slitWidthM: MonteCarloMeasurement;
  centralMaximumWidthM: MonteCarloMeasurement;
}

export type MonteCarloWavelengthParameters =
  | DoubleSlitMonteCarloParameters
  | SingleSlitMonteCarloParameters;

export interface MonteCarloWavelengthResult {
  samples: number;
  seed: number;
  confidenceLevel: number;
  meanM: Metres;
  medianM: Metres;
  standardUncertaintyM: Metres;
  lowerBoundM: Metres;
  upperBoundM: Metres;
}

const DEFAULT_MONTE_CARLO_SAMPLES = 5_000;
const DEFAULT_MONTE_CARLO_SEED = 0x5eed1234;

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite.`);
  }
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) {
    throw new RangeError(`${name} must be greater than zero.`);
  }
}

function requireNonNegative(value: number, name: string): void {
  requireFinite(value, name);
  if (value < 0) {
    throw new RangeError(`${name} must not be negative.`);
  }
}

/** Numerically stable sin(z) / z, with the removable singularity at z = 0. */
export function sinc0(z: number): number {
  requireFinite(z, "z");
  const absoluteZ = Math.abs(z);
  if (absoluteZ < 1e-4) {
    const z2 = z * z;
    return 1 - z2 / 6 + (z2 * z2) / 120 - (z2 * z2 * z2) / 5_040;
  }
  return Math.sin(z) / z;
}

/** Exact screen angle atan((x - x0) / L), in radians. */
export function screenThetaRadians({
  screenPositionM,
  screenDistanceM,
  centerPositionM = 0,
}: ScreenGeometry): number {
  requireFinite(screenPositionM, "screenPositionM");
  requireFinite(centerPositionM, "centerPositionM");
  requirePositive(screenDistanceM, "screenDistanceM");
  return Math.atan2(screenPositionM - centerPositionM, screenDistanceM);
}

/** Exact sin(atan((x - x0) / L)); avoids the small-angle x/L approximation. */
export function screenSinTheta(geometry: ScreenGeometry): number {
  const offsetM = geometry.screenPositionM - (geometry.centerPositionM ?? 0);
  requireFinite(offsetM, "screenPositionM - centerPositionM");
  requirePositive(geometry.screenDistanceM, "screenDistanceM");
  return offsetM / Math.hypot(geometry.screenDistanceM, offsetM);
}

/** Small-angle approximation sin(theta) ~= (x - x0) / L. */
export function smallAngleSinTheta({
  screenPositionM,
  screenDistanceM,
  centerPositionM = 0,
}: ScreenGeometry): number {
  requireFinite(screenPositionM, "screenPositionM");
  requireFinite(centerPositionM, "centerPositionM");
  requirePositive(screenDistanceM, "screenDistanceM");
  return (screenPositionM - centerPositionM) / screenDistanceM;
}

function relativeBackground(
  screenPositionM: Metres,
  centerPositionM: Metres,
  model: RelativeIntensityModel,
): number {
  const amplitude = model.amplitude ?? 1;
  const background = model.background ?? 0;
  const slope = model.backgroundSlopePerM ?? 0;
  requireNonNegative(amplitude, "amplitude");
  requireFinite(background, "background");
  requireFinite(slope, "backgroundSlopePerM");
  return background + slope * (screenPositionM - centerPositionM);
}

/** Fraunhofer single-slit sinc^2 relative intensity at one screen coordinate. */
export function singleSlitIntensity({
  screenPositionM,
  screenDistanceM,
  centerPositionM = 0,
  wavelengthM,
  slitWidthM,
  amplitude = 1,
  background = 0,
  backgroundSlopePerM = 0,
}: SingleSlitIntensityParameters): number {
  requirePositive(wavelengthM, "wavelengthM");
  requirePositive(slitWidthM, "slitWidthM");
  const sinTheta = screenSinTheta({
    screenPositionM,
    screenDistanceM,
    centerPositionM,
  });
  const beta = (Math.PI * slitWidthM * sinTheta) / wavelengthM;
  const diffraction = sinc0(beta);
  return (
    relativeBackground(screenPositionM, centerPositionM, {
      amplitude,
      background,
      backgroundSlopePerM,
    }) + amplitude * diffraction * diffraction
  );
}

/**
 * Finite-width double-slit intensity. With visibility=1 and phase=0, the
 * interference factor is exactly cos(alpha)^2 under a sinc^2 envelope.
 */
export function finiteDoubleSlitIntensity({
  screenPositionM,
  screenDistanceM,
  centerPositionM = 0,
  wavelengthM,
  slitWidthM,
  slitSeparationM,
  visibility = 1,
  phaseRadians = 0,
  amplitude = 1,
  background = 0,
  backgroundSlopePerM = 0,
}: FiniteDoubleSlitIntensityParameters): number {
  requirePositive(wavelengthM, "wavelengthM");
  requirePositive(slitWidthM, "slitWidthM");
  requirePositive(slitSeparationM, "slitSeparationM");
  requireFinite(visibility, "visibility");
  requireFinite(phaseRadians, "phaseRadians");
  if (visibility < 0 || visibility > 1) {
    throw new RangeError("visibility must be between 0 and 1.");
  }

  const sinTheta = screenSinTheta({
    screenPositionM,
    screenDistanceM,
    centerPositionM,
  });
  const beta = (Math.PI * slitWidthM * sinTheta) / wavelengthM;
  const alpha = (Math.PI * slitSeparationM * sinTheta) / wavelengthM;
  const envelope = sinc0(beta) ** 2;
  const interference =
    (1 + visibility * Math.cos(2 * alpha + phaseRadians)) / 2;

  return (
    relativeBackground(screenPositionM, centerPositionM, {
      amplitude,
      background,
      backgroundSlopePerM,
    }) + amplitude * envelope * interference
  );
}

/** Alias emphasizing that the implemented double-slit model includes slit width. */
export const doubleSlitIntensity = finiteDoubleSlitIntensity;

/** Weighted least-squares fit of sin(theta) = intercept + slope * order. */
export function weightedLinearRegression(
  points: readonly RegressionPoint[],
): WeightedLinearRegressionResult {
  if (points.length < 2) {
    throw new RangeError("At least two regression points are required.");
  }

  let sumWeight = 0;
  let sumWeightedX = 0;
  let sumWeightedY = 0;
  for (const point of points) {
    requireFinite(point.order, "point.order");
    requireFinite(point.sinTheta, "point.sinTheta");
    const weight = point.weight ?? 1;
    requirePositive(weight, "point.weight");
    sumWeight += weight;
    sumWeightedX += weight * point.order;
    sumWeightedY += weight * point.sinTheta;
  }

  requirePositive(sumWeight, "sumWeight");
  const meanX = sumWeightedX / sumWeight;
  const meanY = sumWeightedY / sumWeight;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    const weight = point.weight ?? 1;
    const dx = point.order - meanX;
    sxx += weight * dx * dx;
    sxy += weight * dx * (point.sinTheta - meanY);
  }
  if (sxx <= Number.EPSILON * Math.max(1, sumWeight)) {
    throw new RangeError("Regression orders must contain at least two distinct values.");
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const residuals = points.map(
    (point) => point.sinTheta - (intercept + slope * point.order),
  );
  let weightedSumSquaredResiduals = 0;
  let weightedTotalSumSquares = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const weight = point.weight ?? 1;
    weightedSumSquaredResiduals += weight * residuals[index] ** 2;
    weightedTotalSumSquares += weight * (point.sinTheta - meanY) ** 2;
  }

  const degreesOfFreedom = points.length - 2;
  const residualVariance =
    degreesOfFreedom > 0
      ? weightedSumSquaredResiduals / degreesOfFreedom
      : null;
  const slopeStandardError =
    residualVariance === null ? null : Math.sqrt(residualVariance / sxx);
  const interceptStandardError =
    residualVariance === null
      ? null
      : Math.sqrt(residualVariance * (1 / sumWeight + (meanX * meanX) / sxx));
  const residualStandardError =
    residualVariance === null ? null : Math.sqrt(residualVariance);

  let rSquared: number;
  if (weightedTotalSumSquares <= Number.EPSILON) {
    rSquared = weightedSumSquaredResiduals <= Number.EPSILON ? 1 : 0;
  } else {
    rSquared = 1 - weightedSumSquaredResiduals / weightedTotalSumSquares;
  }

  return {
    slope,
    intercept,
    slopeStandardError,
    interceptStandardError,
    residualStandardError,
    rSquared,
    weightedSumSquaredResiduals,
    degreesOfFreedom,
    residuals,
  };
}

function screenObservationToRegressionPoint(
  observation: ScreenOrderObservation,
  screenDistanceM: Metres,
  centerPositionM: Metres,
): RegressionPoint {
  requireFinite(observation.order, "observation.order");
  requireFinite(observation.screenPositionM, "observation.screenPositionM");
  if (
    observation.weight !== undefined &&
    observation.standardUncertaintyM !== undefined
  ) {
    throw new RangeError(
      "An observation cannot define both weight and standardUncertaintyM.",
    );
  }

  let weight = observation.weight;
  if (observation.standardUncertaintyM !== undefined) {
    requirePositive(
      observation.standardUncertaintyM,
      "observation.standardUncertaintyM",
    );
    const offsetM = observation.screenPositionM - centerPositionM;
    const denominator = Math.hypot(screenDistanceM, offsetM);
    const derivative = (screenDistanceM * screenDistanceM) / denominator ** 3;
    const standardUncertaintySinTheta =
      derivative * observation.standardUncertaintyM;
    weight = 1 / standardUncertaintySinTheta ** 2;
  }
  if (weight !== undefined) {
    requirePositive(weight, "observation.weight");
  }

  return {
    order: observation.order,
    sinTheta: screenSinTheta({
      screenPositionM: observation.screenPositionM,
      screenDistanceM,
      centerPositionM,
    }),
    weight,
  };
}

function isIntegerWithinTolerance(value: number): boolean {
  return Math.abs(value - Math.round(value)) <= 1e-9;
}

function isHalfIntegerWithinTolerance(value: number): boolean {
  return Math.abs(Math.abs(value) % 1 - 0.5) <= 1e-9;
}

function wavelengthRegression(
  points: readonly RegressionPoint[],
  apertureM: Metres,
): WavelengthRegressionResult {
  requirePositive(apertureM, "apertureM");
  const regression = weightedLinearRegression(points);
  return {
    ...regression,
    wavelengthM: apertureM * Math.abs(regression.slope),
    wavelengthStandardErrorM:
      regression.slopeStandardError === null
        ? null
        : apertureM * regression.slopeStandardError,
    transformedPoints: points,
  };
}

/** Fit single-slit dark minima a*sin(theta_n) = n*lambda. */
export function fitSingleSlitDarkFringes({
  observations,
  screenDistanceM,
  slitWidthM,
  centerPositionM = 0,
}: SingleSlitRegressionParameters): WavelengthRegressionResult {
  requirePositive(screenDistanceM, "screenDistanceM");
  requirePositive(slitWidthM, "slitWidthM");
  for (const observation of observations) {
    if (!isIntegerWithinTolerance(observation.order) || observation.order === 0) {
      throw new RangeError(
        "Single-slit dark-fringe orders must be non-zero integers.",
      );
    }
  }
  const points = observations.map((observation) =>
    screenObservationToRegressionPoint(
      observation,
      screenDistanceM,
      centerPositionM,
    ),
  );
  return wavelengthRegression(points, slitWidthM);
}

/** Fit double-slit maxima d*sin(theta_m)=m*lambda or half-integer minima. */
export function fitDoubleSlitOrders({
  observations,
  screenDistanceM,
  slitSeparationM,
  centerPositionM = 0,
  fringeType = "maximum",
}: DoubleSlitRegressionParameters): WavelengthRegressionResult {
  requirePositive(screenDistanceM, "screenDistanceM");
  requirePositive(slitSeparationM, "slitSeparationM");
  for (const observation of observations) {
    const validOrder =
      fringeType === "maximum"
        ? isIntegerWithinTolerance(observation.order)
        : isHalfIntegerWithinTolerance(observation.order);
    if (!validOrder) {
      throw new RangeError(
        fringeType === "maximum"
          ? "Double-slit maximum orders must be integers."
          : "Double-slit minimum orders must be half-integers.",
      );
    }
  }
  const points = observations.map((observation) =>
    screenObservationToRegressionPoint(
      observation,
      screenDistanceM,
      centerPositionM,
    ),
  );
  return wavelengthRegression(points, slitSeparationM);
}

/** Compute lambda = aperture * |sin(theta)| / |order| using exact geometry. */
export function wavelengthFromExactOrder({
  apertureM,
  order,
  ...geometry
}: ExactOrderWavelengthParameters): Metres {
  requirePositive(apertureM, "apertureM");
  requireFinite(order, "order");
  if (order === 0) {
    throw new RangeError("order must be non-zero.");
  }
  return (apertureM * Math.abs(screenSinTheta(geometry))) / Math.abs(order);
}

/** Small-angle double-slit result lambda = d * Delta x / L. */
export function doubleSlitWavelengthSmallAngle({
  slitSeparationM,
  fringeSpacingM,
  screenDistanceM,
}: DoubleSlitSmallAngleParameters): Metres {
  requirePositive(slitSeparationM, "slitSeparationM");
  requirePositive(fringeSpacingM, "fringeSpacingM");
  requirePositive(screenDistanceM, "screenDistanceM");
  return (slitSeparationM * fringeSpacingM) / screenDistanceM;
}

/** Small-angle single-slit result lambda = a * W0 / (2 L). */
export function singleSlitWavelengthSmallAngle({
  slitWidthM,
  centralMaximumWidthM,
  screenDistanceM,
}: SingleSlitSmallAngleParameters): Metres {
  requirePositive(slitWidthM, "slitWidthM");
  requirePositive(centralMaximumWidthM, "centralMaximumWidthM");
  requirePositive(screenDistanceM, "screenDistanceM");
  return (slitWidthM * centralMaximumWidthM) / (2 * screenDistanceM);
}

/** Single-slit Fresnel number, using aperture half-width A = a/2. */
export function singleSlitFresnelNumber({
  slitWidthM,
  wavelengthM,
  screenDistanceM,
}: FresnelNumberSingleSlitParameters): number {
  requirePositive(slitWidthM, "slitWidthM");
  requirePositive(wavelengthM, "wavelengthM");
  requirePositive(screenDistanceM, "screenDistanceM");
  const apertureHalfWidthM = slitWidthM / 2;
  return (
    (apertureHalfWidthM * apertureHalfWidthM) /
    (wavelengthM * screenDistanceM)
  );
}

/** Double-slit Fresnel number, using total-aperture half-width A = (d+a)/2. */
export function doubleSlitFresnelNumber({
  slitWidthM,
  slitSeparationM,
  wavelengthM,
  screenDistanceM,
}: FresnelNumberDoubleSlitParameters): number {
  requirePositive(slitWidthM, "slitWidthM");
  requirePositive(slitSeparationM, "slitSeparationM");
  requirePositive(wavelengthM, "wavelengthM");
  requirePositive(screenDistanceM, "screenDistanceM");
  const apertureHalfWidthM = (slitSeparationM + slitWidthM) / 2;
  return (
    (apertureHalfWidthM * apertureHalfWidthM) /
    (wavelengthM * screenDistanceM)
  );
}

/** Root-sum-square relative uncertainty for independent product/quotient terms. */
export function firstOrderRelativeUncertainty(
  measurements: readonly ScalarMeasurement[],
): number {
  if (measurements.length === 0) {
    return 0;
  }
  let relativeVariance = 0;
  for (const measurement of measurements) {
    requirePositive(Math.abs(measurement.value), "measurement.value magnitude");
    requireNonNegative(
      measurement.standardUncertainty,
      "measurement.standardUncertainty",
    );
    relativeVariance +=
      (measurement.standardUncertainty / measurement.value) ** 2;
  }
  return Math.sqrt(relativeVariance);
}

/** First-order uncertainty for lambda = d * Delta x / L. */
export function doubleSlitSmallAngleUncertainty(
  parameters: DoubleSlitSmallAngleUncertaintyParameters,
): WavelengthUncertaintyResult {
  const wavelengthM = doubleSlitWavelengthSmallAngle({
    slitSeparationM: parameters.slitSeparationM.value,
    fringeSpacingM: parameters.fringeSpacingM.value,
    screenDistanceM: parameters.screenDistanceM.value,
  });
  const relativeStandardUncertainty = firstOrderRelativeUncertainty([
    parameters.slitSeparationM,
    parameters.fringeSpacingM,
    parameters.screenDistanceM,
  ]);
  return {
    wavelengthM,
    standardUncertaintyM: wavelengthM * relativeStandardUncertainty,
    relativeStandardUncertainty,
  };
}

/** First-order uncertainty for lambda = a * W0 / (2 L). */
export function singleSlitSmallAngleUncertainty(
  parameters: SingleSlitSmallAngleUncertaintyParameters,
): WavelengthUncertaintyResult {
  const wavelengthM = singleSlitWavelengthSmallAngle({
    slitWidthM: parameters.slitWidthM.value,
    centralMaximumWidthM: parameters.centralMaximumWidthM.value,
    screenDistanceM: parameters.screenDistanceM.value,
  });
  const relativeStandardUncertainty = firstOrderRelativeUncertainty([
    parameters.slitWidthM,
    parameters.centralMaximumWidthM,
    parameters.screenDistanceM,
  ]);
  return {
    wavelengthM,
    standardUncertaintyM: wavelengthM * relativeStandardUncertainty,
    relativeStandardUncertainty,
  };
}

/** Mulberry32 PRNG. Same unsigned 32-bit seed produces the same sequence. */
export function createSeededRandom(seed: number): () => number {
  requireFinite(seed, "seed");
  if (!Number.isInteger(seed)) {
    throw new RangeError("seed must be an integer.");
  }
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function sampleStandardNormal(random: () => number): number {
  let first = random();
  const second = random();
  if (first <= Number.EPSILON) {
    first = Number.EPSILON;
  }
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function validateMonteCarloMeasurement(
  measurement: MonteCarloMeasurement,
  name: string,
): void {
  requirePositive(measurement.value, `${name}.value`);
  requireNonNegative(
    measurement.standardUncertainty,
    `${name}.standardUncertainty`,
  );
  const distribution = measurement.distribution ?? "normal";
  if (distribution !== "normal" && distribution !== "rectangular") {
    throw new RangeError(`${name}.distribution is not supported.`);
  }
}

function samplePositiveMeasurement(
  measurement: MonteCarloMeasurement,
  random: () => number,
): number {
  if (measurement.standardUncertainty === 0) {
    return measurement.value;
  }
  const distribution = measurement.distribution ?? "normal";
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const variation =
      distribution === "normal"
        ? measurement.standardUncertainty * sampleStandardNormal(random)
        : measurement.standardUncertainty * Math.sqrt(3) * (2 * random() - 1);
    const sample = measurement.value + variation;
    if (sample > 0 && Number.isFinite(sample)) {
      return sample;
    }
  }
  throw new RangeError(
    "Could not draw a positive physical value; check nominal values and uncertainties.",
  );
}

function quantile(sortedValues: readonly number[], probability: number): number {
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const fraction = position - lowerIndex;
  const upper = sortedValues[lowerIndex + 1];
  return upper === undefined
    ? sortedValues[lowerIndex]
    : sortedValues[lowerIndex] * (1 - fraction) + upper * fraction;
}

/**
 * Reproducible Monte Carlo interval for either supported small-angle wavelength
 * formula. Non-positive physical draws are rejected and redrawn.
 */
export function monteCarloWavelength(
  parameters: MonteCarloWavelengthParameters,
): MonteCarloWavelengthResult {
  const samples = parameters.samples ?? DEFAULT_MONTE_CARLO_SAMPLES;
  const seed = parameters.seed ?? DEFAULT_MONTE_CARLO_SEED;
  const confidenceLevel = parameters.confidenceLevel ?? 0.95;
  if (!Number.isInteger(samples) || samples < 2) {
    throw new RangeError("samples must be an integer of at least 2.");
  }
  requireFinite(confidenceLevel, "confidenceLevel");
  if (confidenceLevel <= 0 || confidenceLevel >= 1) {
    throw new RangeError("confidenceLevel must be between 0 and 1.");
  }
  validateMonteCarloMeasurement(
    parameters.screenDistanceM,
    "screenDistanceM",
  );
  if (parameters.experiment === "double-slit-small-angle") {
    validateMonteCarloMeasurement(
      parameters.slitSeparationM,
      "slitSeparationM",
    );
    validateMonteCarloMeasurement(parameters.fringeSpacingM, "fringeSpacingM");
  } else {
    validateMonteCarloMeasurement(parameters.slitWidthM, "slitWidthM");
    validateMonteCarloMeasurement(
      parameters.centralMaximumWidthM,
      "centralMaximumWidthM",
    );
  }

  const random = createSeededRandom(seed);
  const wavelengths = new Array<number>(samples);
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const screenDistanceM = samplePositiveMeasurement(
      parameters.screenDistanceM,
      random,
    );
    let wavelengthM: number;
    if (parameters.experiment === "double-slit-small-angle") {
      wavelengthM = doubleSlitWavelengthSmallAngle({
        slitSeparationM: samplePositiveMeasurement(
          parameters.slitSeparationM,
          random,
        ),
        fringeSpacingM: samplePositiveMeasurement(
          parameters.fringeSpacingM,
          random,
        ),
        screenDistanceM,
      });
    } else {
      wavelengthM = singleSlitWavelengthSmallAngle({
        slitWidthM: samplePositiveMeasurement(parameters.slitWidthM, random),
        centralMaximumWidthM: samplePositiveMeasurement(
          parameters.centralMaximumWidthM,
          random,
        ),
        screenDistanceM,
      });
    }
    wavelengths[index] = wavelengthM;
    sum += wavelengthM;
  }

  const meanM = sum / samples;
  let squaredDeviationSum = 0;
  for (const wavelengthM of wavelengths) {
    squaredDeviationSum += (wavelengthM - meanM) ** 2;
  }
  const standardUncertaintyM = Math.sqrt(squaredDeviationSum / (samples - 1));
  const sortedWavelengths = [...wavelengths].sort((left, right) => left - right);
  const tailProbability = (1 - confidenceLevel) / 2;

  return {
    samples,
    seed,
    confidenceLevel,
    meanM,
    medianM: quantile(sortedWavelengths, 0.5),
    standardUncertaintyM,
    lowerBoundM: quantile(sortedWavelengths, tailProbability),
    upperBoundM: quantile(sortedWavelengths, 1 - tailProbability),
  };
}

export const monteCarloWavelengthInterval = monteCarloWavelength;
