/**
 * Dependency-free signal processing primitives used by the camera analyser.
 *
 * All calculations are deliberately performed in floating point. In particular,
 * background subtraction may produce legitimate negative noise samples and must
 * not be performed on Uint8Array/Uint8ClampedArray values in place.
 */

export type NumericArray = ArrayLike<number>;

export type ProfileChannel = "r" | "g" | "b" | "luminance";
export type RequestedProfileChannel = ProfileChannel | "auto";
export type FringeOrientation = "vertical" | "horizontal";

export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

export interface StripRoi {
  /** ROI centre in source-image pixels. */
  readonly centerX?: number;
  /** ROI centre in source-image pixels. */
  readonly centerY?: number;
  /** Optional axis-aligned left edge; used when centerX is omitted. */
  readonly x?: number;
  /** Optional axis-aligned top edge; used when centerY is omitted. */
  readonly y?: number;
  /** Local ROI width in source-image pixels. */
  readonly width: number;
  /** Local ROI height in source-image pixels. */
  readonly height: number;
  /** Clockwise rotation of the ROI's local x axis, in degrees. */
  readonly angleDeg?: number;
}

export interface ExtractStripProfileOptions {
  readonly channel?: RequestedProfileChannel;
  /** Vertical fringes vary along x and are averaged along y; horizontal is the converse. */
  readonly fringeOrientation?: FringeOrientation;
  readonly roi?: StripRoi;
  readonly saturationThreshold?: number;
  /** Maximum source-channel saturation accepted by automatic channel selection. */
  readonly maxAutoSaturationRate?: number;
  /** Minimum robust p95-p05 range accepted as useful signal by automatic selection. */
  readonly minAutoContrast?: number;
}

export interface StripProfileResult {
  readonly profile: Float64Array;
  readonly profiles: Readonly<Record<ProfileChannel, Float64Array>>;
  readonly selectedChannel: ProfileChannel;
  readonly saturationRates: Readonly<Record<ProfileChannel, number>>;
  readonly contrastScores: Readonly<Record<ProfileChannel, number>>;
  readonly dynamicRanges: Readonly<Record<ProfileChannel, number>>;
  readonly axis: "x" | "y";
  /** Position relative to the ROI centre, in source-image pixels. */
  readonly axisPositionsPx: Float64Array;
  /** Number of valid source samples averaged into each profile bin. */
  readonly samplesPerBin: Uint32Array;
}

export interface PeriodEstimationOptions {
  readonly minLag?: number;
  readonly maxLag?: number;
  readonly minCorrelation?: number;
}

export interface PeriodEstimate {
  readonly period: number | null;
  readonly lag: number | null;
  readonly correlation: number;
  /** Index is lag. Entries below minLag and above maxLag are NaN. */
  readonly autocorrelation: Float64Array;
  readonly minLag: number;
  readonly maxLag: number;
}

export interface FwhmResult {
  readonly width: number;
  readonly left: number;
  readonly right: number;
  readonly halfHeight: number;
  readonly baseline: number;
  readonly truncatedLeft: boolean;
  readonly truncatedRight: boolean;
}

export interface PeakDetectionOptions {
  readonly minProminence?: number;
  /** Alias for minProminence. */
  readonly prominence?: number;
  readonly minDistance?: number;
  /** Alias for minDistance. */
  readonly distance?: number;
  readonly minHeight?: number;
  /** Alias for minHeight. */
  readonly height?: number;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly maxPeaks?: number;
  readonly saturationThreshold?: number;
  /** Adjacent values within this absolute tolerance are treated as one plateau. */
  readonly plateauTolerance?: number;
}

export interface DetectedExtremum {
  readonly type: "peak" | "trough";
  /** Nearest integer sample to position. */
  readonly index: number;
  /** Quadratic subpixel position, or the midpoint for a plateau. */
  readonly position: number;
  readonly value: number;
  readonly prominence: number;
  /** Width at half prominence, with interpolated crossings. */
  readonly width: number | null;
  readonly left: number | null;
  readonly right: number | null;
  readonly halfHeight: number | null;
  readonly plateau: boolean;
  readonly plateauStart: number;
  readonly plateauEnd: number;
  readonly plateauSize: number;
  /** True when a bright peak contains samples at or above saturationThreshold. */
  readonly saturated: boolean;
}

function copyFinite(input: NumericArray, label = "signal"): Float64Array {
  const output = new Float64Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const value = Number(input[index]);
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label}[${index}] must be finite`);
    }
    output[index] = value;
  }
  return output;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return Math.max(1, Math.round(value));
}

function reflectedIndex(index: number, length: number): number {
  if (length <= 1) return 0;
  let reflected = index;
  while (reflected < 0 || reflected >= length) {
    if (reflected < 0) reflected = -reflected;
    if (reflected >= length) reflected = 2 * length - reflected - 2;
  }
  return reflected;
}

/** Gaussian convolution with reflected boundaries. */
export function gaussianSmooth(signal: NumericArray, sigma = 1.5): Float64Array {
  const source = copyFinite(signal);
  if (source.length === 0 || sigma === 0) return source;
  if (!Number.isFinite(sigma) || sigma < 0) {
    throw new RangeError("sigma must be finite and non-negative");
  }

  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float64Array(radius * 2 + 1);
  let kernelSum = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    kernel[offset + radius] = weight;
    kernelSum += weight;
  }
  for (let index = 0; index < kernel.length; index += 1) kernel[index] /= kernelSum;

  const output = new Float64Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      sum += source[reflectedIndex(index + offset, source.length)] * kernel[offset + radius];
    }
    output[index] = sum;
  }
  return output;
}

/** Centred moving average. At the ends, only available samples are averaged. */
export function movingAverageSmooth(signal: NumericArray, windowSize = 5): Float64Array {
  const source = copyFinite(signal);
  if (source.length === 0) return source;
  const size = positiveInteger(windowSize, "windowSize");
  if (size === 1) return source;

  const leftRadius = Math.floor((size - 1) / 2);
  const rightRadius = size - leftRadius - 1;
  const prefix = new Float64Array(source.length + 1);
  for (let index = 0; index < source.length; index += 1) {
    prefix[index + 1] = prefix[index] + source[index];
  }

  const output = new Float64Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    const start = Math.max(0, index - leftRadius);
    const end = Math.min(source.length, index + rightRadius + 1);
    output[index] = (prefix[end] - prefix[start]) / (end - start);
  }
  return output;
}

export const smoothGaussian = gaussianSmooth;
export const smoothMovingAverage = movingAverageSmooth;

/**
 * Estimates a dominant repeat distance from normalised autocorrelation. The first
 * credible positive local maximum is preferred to avoid returning harmonics.
 */
export function estimatePeriodAutocorrelation(
  signal: NumericArray,
  options: PeriodEstimationOptions = {},
): PeriodEstimate {
  const source = copyFinite(signal);
  const length = source.length;
  const minLag = Math.min(Math.max(1, Math.round(options.minLag ?? 2)), Math.max(1, length - 1));
  const requestedMax = options.maxLag ?? Math.floor(length / 2);
  const maxLag = Math.max(minLag, Math.min(length - 1, Math.round(requestedMax)));
  const minimumCorrelation = options.minCorrelation ?? 0.05;
  const correlations = new Float64Array(length);
  correlations.fill(Number.NaN);

  if (length < 4 || minLag >= length) {
    return { period: null, lag: null, correlation: Number.NaN, autocorrelation: correlations, minLag, maxLag };
  }

  let mean = 0;
  for (const value of source) mean += value;
  mean /= length;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let numerator = 0;
    let energyA = 0;
    let energyB = 0;
    for (let index = 0; index < length - lag; index += 1) {
      const a = source[index] - mean;
      const b = source[index + lag] - mean;
      numerator += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    correlations[lag] = energyA > 0 && energyB > 0
      ? numerator / Math.sqrt(energyA * energyB)
      : 0;
  }

  const localMaxima: number[] = [];
  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    if (
      correlations[lag] >= correlations[lag - 1]
      && correlations[lag] > correlations[lag + 1]
      && correlations[lag] >= minimumCorrelation
    ) {
      localMaxima.push(lag);
    }
  }

  let bestLag: number | null = localMaxima[0] ?? null;
  if (bestLag === null) {
    let bestCorrelation = minimumCorrelation;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      if (correlations[lag] > bestCorrelation) {
        bestCorrelation = correlations[lag];
        bestLag = lag;
      }
    }
  }

  if (bestLag === null) {
    return { period: null, lag: null, correlation: Number.NaN, autocorrelation: correlations, minLag, maxLag };
  }

  let subpixelLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    subpixelLag = quadraticSubpixelCenter(correlations, bestLag);
  }
  return {
    period: subpixelLag,
    lag: bestLag,
    correlation: correlations[bestLag],
    autocorrelation: correlations,
    minLag,
    maxLag,
  };
}

export function estimatePeriod(signal: NumericArray, options: PeriodEstimationOptions = {}): number | null {
  return estimatePeriodAutocorrelation(signal, options).period;
}

/** Three-sample parabolic interpolation around an integer extremum. */
export function quadraticSubpixelCenter(signal: NumericArray, peakIndex: number): number {
  const index = Math.round(peakIndex);
  if (index <= 0 || index >= signal.length - 1) return index;
  const left = Number(signal[index - 1]);
  const centre = Number(signal[index]);
  const right = Number(signal[index + 1]);
  if (![left, centre, right].every(Number.isFinite)) return index;
  const denominator = left - 2 * centre + right;
  if (Math.abs(denominator) < Number.EPSILON) return index;
  const offset = 0.5 * (left - right) / denominator;
  return index + Math.max(-1, Math.min(1, offset));
}

function interpolateCrossing(indexA: number, valueA: number, indexB: number, valueB: number, level: number): number {
  const difference = valueB - valueA;
  if (Math.abs(difference) < Number.EPSILON) return (indexA + indexB) / 2;
  const fraction = (level - valueA) / difference;
  return indexA + Math.max(0, Math.min(1, fraction)) * (indexB - indexA);
}

/**
 * Full width at half maximum using linearly interpolated crossings. `baseline`
 * defaults to zero; peak detection passes the local prominence contour instead.
 */
export function calculateFwhm(
  signal: NumericArray,
  peakIndex: number,
  baseline = 0,
): FwhmResult | null {
  if (signal.length === 0) return null;
  const index = Math.max(0, Math.min(signal.length - 1, Math.round(peakIndex)));
  const peak = Number(signal[index]);
  if (!Number.isFinite(peak) || !Number.isFinite(baseline) || peak <= baseline) return null;
  const halfHeight = baseline + (peak - baseline) / 2;

  let leftIndex = index;
  while (leftIndex > 0 && Number(signal[leftIndex]) >= halfHeight) leftIndex -= 1;
  const truncatedLeft = leftIndex === 0 && Number(signal[leftIndex]) >= halfHeight;
  const left = truncatedLeft
    ? 0
    : interpolateCrossing(leftIndex, Number(signal[leftIndex]), leftIndex + 1, Number(signal[leftIndex + 1]), halfHeight);

  let rightIndex = index;
  while (rightIndex < signal.length - 1 && Number(signal[rightIndex]) >= halfHeight) rightIndex += 1;
  const truncatedRight = rightIndex === signal.length - 1 && Number(signal[rightIndex]) >= halfHeight;
  const right = truncatedRight
    ? signal.length - 1
    : interpolateCrossing(rightIndex - 1, Number(signal[rightIndex - 1]), rightIndex, Number(signal[rightIndex]), halfHeight);

  return {
    width: Math.max(0, right - left),
    left,
    right,
    halfHeight,
    baseline,
    truncatedLeft,
    truncatedRight,
  };
}

export const fullWidthHalfMaximum = calculateFwhm;

interface RawCandidate {
  readonly start: number;
  readonly end: number;
  readonly centreIndex: number;
  readonly position: number;
  readonly height: number;
  readonly prominence: number;
  readonly contour: number;
}

function rawPeakCandidates(signal: Float64Array, tolerance: number): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  let index = 1;
  while (index < signal.length - 1) {
    const start = index;
    let end = index;
    while (end + 1 < signal.length && Math.abs(signal[end + 1] - signal[start]) <= tolerance) end += 1;

    const leftValue = signal[start - 1];
    const rightValue = end + 1 < signal.length ? signal[end + 1] : signal[end];
    const height = signal[start];
    if (height > leftValue + tolerance && height > rightValue + tolerance) {
      let leftMinimum = height;
      for (let cursor = start - 1; cursor >= 0; cursor -= 1) {
        if (signal[cursor] < leftMinimum) leftMinimum = signal[cursor];
        if (signal[cursor] > height + tolerance) break;
      }
      let rightMinimum = height;
      for (let cursor = end + 1; cursor < signal.length; cursor += 1) {
        if (signal[cursor] < rightMinimum) rightMinimum = signal[cursor];
        if (signal[cursor] > height + tolerance) break;
      }
      const contour = Math.max(leftMinimum, rightMinimum);
      const centreIndex = Math.round((start + end) / 2);
      const position = start === end
        ? quadraticSubpixelCenter(signal, centreIndex)
        : (start + end) / 2;
      candidates.push({
        start,
        end,
        centreIndex,
        position,
        height,
        prominence: Math.max(0, height - contour),
        contour,
      });
    }
    index = Math.max(index + 1, end + 1);
  }
  return candidates;
}

function detectExtrema(
  originalSignal: NumericArray,
  type: "peak" | "trough",
  options: PeakDetectionOptions,
): DetectedExtremum[] {
  const original = copyFinite(originalSignal);
  if (original.length < 3) return [];
  const transformed = type === "peak"
    ? original
    : Float64Array.from(original, (value) => -value);
  const minimumProminence = Math.max(0, options.minProminence ?? options.prominence ?? 0);
  const minimumDistance = Math.max(0, options.minDistance ?? options.distance ?? 1);
  const minimumHeight = options.minHeight ?? options.height;
  const tolerance = Math.max(0, options.plateauTolerance ?? 0);
  const saturationThreshold = options.saturationThreshold ?? 250;

  const candidates = rawPeakCandidates(transformed, tolerance).filter((candidate) => {
    const displayedValue = original[candidate.centreIndex];
    const passesHeight = minimumHeight === undefined
      || (type === "peak" ? displayedValue >= minimumHeight : displayedValue <= minimumHeight);
    if (!passesHeight || candidate.prominence < minimumProminence) return false;
    if (options.minWidth === undefined && options.maxWidth === undefined) return true;
    const width = calculateFwhm(transformed, candidate.centreIndex, candidate.contour)?.width ?? 0;
    return width >= (options.minWidth ?? 0) && width <= (options.maxWidth ?? Number.POSITIVE_INFINITY);
  });

  candidates.sort((a, b) => b.height - a.height || b.prominence - a.prominence);
  const selected: RawCandidate[] = [];
  for (const candidate of candidates) {
    if (selected.every((kept) => Math.abs(candidate.position - kept.position) >= minimumDistance)) {
      selected.push(candidate);
      if (options.maxPeaks !== undefined && selected.length >= Math.max(0, Math.floor(options.maxPeaks))) break;
    }
  }
  selected.sort((a, b) => a.position - b.position);

  return selected.map((candidate): DetectedExtremum => {
    const width = calculateFwhm(transformed, candidate.centreIndex, candidate.contour);
    let saturated = false;
    if (type === "peak") {
      for (let sample = candidate.start; sample <= candidate.end; sample += 1) {
        if (original[sample] >= saturationThreshold) saturated = true;
      }
    }
    return {
      type,
      index: candidate.centreIndex,
      position: candidate.position,
      value: original[candidate.centreIndex],
      prominence: candidate.prominence,
      width: width?.width ?? null,
      left: width?.left ?? null,
      right: width?.right ?? null,
      halfHeight: width === null
        ? null
        : type === "peak" ? width.halfHeight : -width.halfHeight,
      plateau: candidate.end > candidate.start,
      plateauStart: candidate.start,
      plateauEnd: candidate.end,
      plateauSize: candidate.end - candidate.start + 1,
      saturated,
    };
  });
}

export function detectPeaks(signal: NumericArray, options: PeakDetectionOptions = {}): DetectedExtremum[] {
  return detectExtrema(signal, "peak", options);
}

export function detectTroughs(signal: NumericArray, options: PeakDetectionOptions = {}): DetectedExtremum[] {
  return detectExtrema(signal, "trough", options);
}

export const findPeaks = detectPeaks;
export const findTroughs = detectTroughs;

export function detectPeaksAndTroughs(
  signal: NumericArray,
  options: PeakDetectionOptions = {},
): { readonly peaks: DetectedExtremum[]; readonly troughs: DetectedExtremum[] } {
  return { peaks: detectPeaks(signal, options), troughs: detectTroughs(signal, options) };
}

/** Floating-point background subtraction with optional display-only zero clipping. */
export function subtractBackground(
  signal: NumericArray,
  background: number | NumericArray,
  clampToZero = false,
): Float64Array {
  const source = copyFinite(signal);
  const output = new Float64Array(source.length);
  if (typeof background === "number") {
    if (!Number.isFinite(background)) throw new RangeError("background must be finite");
    for (let index = 0; index < source.length; index += 1) {
      const corrected = source[index] - background;
      output[index] = clampToZero ? Math.max(0, corrected) : corrected;
    }
    return output;
  }

  if (background.length !== source.length) {
    throw new RangeError("background and signal must have equal lengths");
  }
  for (let index = 0; index < source.length; index += 1) {
    const backgroundValue = Number(background[index]);
    if (!Number.isFinite(backgroundValue)) throw new RangeError(`background[${index}] must be finite`);
    const corrected = source[index] - backgroundValue;
    output[index] = clampToZero ? Math.max(0, corrected) : corrected;
  }
  return output;
}

export const backgroundSubtract = subtractBackground;

function quantile(values: NumericArray, fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values, Number).sort((a, b) => a - b);
  const position = Math.max(0, Math.min(1, fraction)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function robustChannelScore(profile: Float64Array): { dynamicRange: number; score: number } {
  const dynamicRange = quantile(profile, 0.95) - quantile(profile, 0.05);
  if (profile.length < 2) return { dynamicRange, score: dynamicRange };
  const differences = new Float64Array(profile.length - 1);
  for (let index = 0; index < differences.length; index += 1) {
    differences[index] = Math.abs(profile[index + 1] - profile[index]);
  }
  const noiseProxy = quantile(differences, 0.5) / 0.6745;
  return { dynamicRange, score: dynamicRange / (1 + noiseProxy) };
}

function bilinearRgba(image: ImageDataLike, x: number, y: number): readonly [number, number, number] | null {
  if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;

  const sample = (sampleX: number, sampleY: number, channel: number): number => {
    const value = Number(image.data[(sampleY * image.width + sampleX) * 4 + channel]);
    return Number.isFinite(value) ? value : 0;
  };
  const interpolate = (channel: number): number => {
    const top = sample(x0, y0, channel) * (1 - tx) + sample(x1, y0, channel) * tx;
    const bottom = sample(x0, y1, channel) * (1 - tx) + sample(x1, y1, channel) * tx;
    return top * (1 - ty) + bottom * ty;
  };
  return [interpolate(0), interpolate(1), interpolate(2)];
}

/**
 * Extracts a one-dimensional profile from an optionally rotated strip. For
 * vertical fringes it averages along their y direction and returns variation
 * along x; for horizontal fringes it averages along x and returns variation y.
 */
export function extractStripProfile(
  image: ImageDataLike,
  options: ExtractStripProfileOptions = {},
): StripProfileResult {
  const imageWidth = positiveInteger(image.width, "image.width");
  const imageHeight = positiveInteger(image.height, "image.height");
  if (image.data.length < imageWidth * imageHeight * 4) {
    throw new RangeError("image.data is shorter than width * height * 4");
  }

  const requestedRoi = options.roi;
  const roi = requestedRoi === undefined ? {
    centerX: (imageWidth - 1) / 2,
    centerY: (imageHeight - 1) / 2,
    width: imageWidth,
    height: imageHeight,
    angleDeg: 0,
  } : {
    centerX: requestedRoi.centerX
      ?? (requestedRoi.x === undefined ? (imageWidth - 1) / 2 : requestedRoi.x + (requestedRoi.width - 1) / 2),
    centerY: requestedRoi.centerY
      ?? (requestedRoi.y === undefined ? (imageHeight - 1) / 2 : requestedRoi.y + (requestedRoi.height - 1) / 2),
    width: requestedRoi.width,
    height: requestedRoi.height,
    angleDeg: requestedRoi.angleDeg ?? 0,
  };
  if (![roi.centerX, roi.centerY, roi.width, roi.height, roi.angleDeg ?? 0].every(Number.isFinite)) {
    throw new RangeError("ROI values must be finite");
  }
  if (roi.width <= 0 || roi.height <= 0) throw new RangeError("ROI dimensions must be positive");

  const orientation = options.fringeOrientation ?? "vertical";
  const profileCount = positiveInteger(orientation === "vertical" ? roi.width : roi.height, "profile length");
  const averageCount = positiveInteger(orientation === "vertical" ? roi.height : roi.width, "strip width");
  const angle = (roi.angleDeg ?? 0) * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const saturationThreshold = options.saturationThreshold ?? 250;

  const red = new Float64Array(profileCount);
  const green = new Float64Array(profileCount);
  const blue = new Float64Array(profileCount);
  const luminance = new Float64Array(profileCount);
  const samplesPerBin = new Uint32Array(profileCount);
  const saturatedCounts: Record<ProfileChannel, number> = { r: 0, g: 0, b: 0, luminance: 0 };
  let totalSamples = 0;

  for (let profileIndex = 0; profileIndex < profileCount; profileIndex += 1) {
    for (let averageIndex = 0; averageIndex < averageCount; averageIndex += 1) {
      const localProfile = ((profileIndex + 0.5) / profileCount - 0.5)
        * (orientation === "vertical" ? roi.width : roi.height);
      const localAverage = ((averageIndex + 0.5) / averageCount - 0.5)
        * (orientation === "vertical" ? roi.height : roi.width);
      const localX = orientation === "vertical" ? localProfile : localAverage;
      const localY = orientation === "vertical" ? localAverage : localProfile;
      const sourceX = roi.centerX + localX * cosine - localY * sine;
      const sourceY = roi.centerY + localX * sine + localY * cosine;
      const rgba = bilinearRgba(image, sourceX, sourceY);
      if (rgba === null) continue;

      const [r, g, b] = rgba;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      red[profileIndex] += r;
      green[profileIndex] += g;
      blue[profileIndex] += b;
      luminance[profileIndex] += lum;
      samplesPerBin[profileIndex] += 1;
      totalSamples += 1;
      if (r >= saturationThreshold) saturatedCounts.r += 1;
      if (g >= saturationThreshold) saturatedCounts.g += 1;
      if (b >= saturationThreshold) saturatedCounts.b += 1;
      // Luminance inherits clipping from any contributing source channel.
      if (r >= saturationThreshold || g >= saturationThreshold || b >= saturationThreshold) {
        saturatedCounts.luminance += 1;
      }
    }
    const count = samplesPerBin[profileIndex];
    if (count > 0) {
      red[profileIndex] /= count;
      green[profileIndex] /= count;
      blue[profileIndex] /= count;
      luminance[profileIndex] /= count;
    }
  }

  const profiles: Record<ProfileChannel, Float64Array> = { r: red, g: green, b: blue, luminance };
  const saturationRates: Record<ProfileChannel, number> = {
    r: totalSamples === 0 ? 0 : saturatedCounts.r / totalSamples,
    g: totalSamples === 0 ? 0 : saturatedCounts.g / totalSamples,
    b: totalSamples === 0 ? 0 : saturatedCounts.b / totalSamples,
    luminance: totalSamples === 0 ? 0 : saturatedCounts.luminance / totalSamples,
  };
  const contrastScores = {} as Record<ProfileChannel, number>;
  const dynamicRanges = {} as Record<ProfileChannel, number>;
  const channels: readonly ProfileChannel[] = ["r", "g", "b", "luminance"];
  for (const channel of channels) {
    const metrics = robustChannelScore(profiles[channel]);
    contrastScores[channel] = metrics.score;
    dynamicRanges[channel] = metrics.dynamicRange;
  }

  const requestedChannel = options.channel ?? "auto";
  let selectedChannel: ProfileChannel;
  if (requestedChannel !== "auto") {
    selectedChannel = requestedChannel;
  } else {
    const maxSaturation = options.maxAutoSaturationRate ?? 0.005;
    const minimumContrast = options.minAutoContrast ?? 2;
    const usable = channels.filter(
      (channel) => saturationRates[channel] <= maxSaturation && dynamicRanges[channel] >= minimumContrast,
    );
    const candidates = usable.length > 0 ? usable : channels;
    selectedChannel = candidates.reduce((best, channel) => {
      const saturationPenalty = Math.exp(-50 * saturationRates[channel]);
      const score = contrastScores[channel] * saturationPenalty;
      const bestScore = contrastScores[best] * Math.exp(-50 * saturationRates[best]);
      return score > bestScore ? channel : best;
    });
  }

  const axisPositionsPx = new Float64Array(profileCount);
  const physicalSpan = orientation === "vertical" ? roi.width : roi.height;
  for (let index = 0; index < profileCount; index += 1) {
    axisPositionsPx[index] = ((index + 0.5) / profileCount - 0.5) * physicalSpan;
  }

  return {
    profile: profiles[selectedChannel],
    profiles,
    selectedChannel,
    saturationRates,
    contrastScores,
    dynamicRanges,
    axis: orientation === "vertical" ? "x" : "y",
    axisPositionsPx,
    samplesPerBin,
  };
}

export const extractIntensityProfile = extractStripProfile;
