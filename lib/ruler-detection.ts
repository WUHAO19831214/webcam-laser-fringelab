import type { Point } from "./roi";
import type { RulerCalibration } from "./ruler";
import type { ImageDataLike } from "./signal";

export type RulerContrastMode =
  | "auto"
  | "light-on-dark"
  | "dark-on-light"
  | "cyan"
  | "magenta";

export type ResolvedRulerContrast = Exclude<RulerContrastMode, "auto">;
export type RulerDetectionStatus = "idle" | "detecting" | "ready" | "degraded" | "failed" | "stale";
export type RulerTickKind = "minor" | "medium" | "major";

export type RulerRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DetectedRulerTick = {
  point: Point;
  axisPositionPx: number;
  millimetreIndex: number;
  lengthPx: number;
  kind: RulerTickKind;
  inlier: boolean;
};

export type DetectedRulerNumber = {
  text: string;
  value: number;
  point: Point;
  axisPositionPx: number;
  confidence: number;
  associatedMillimetreIndex: number | null;
};

export type RulerFitStatistics = {
  pixelsPerMm: number;
  mmPerPixel: number;
  offsetPx: number;
  residualRmsPx: number;
  inlierCount: number;
  totalCount: number;
  missingTickEstimate: number;
  confidence: number;
};

export type RulerTheme = {
  requestedMode: RulerContrastMode;
  resolvedMode: ResolvedRulerContrast;
  sampledLuminance: number;
  localContrast: number;
  complexBackground: boolean;
  stroke: string;
  outline: string;
  fill: string;
  labelFill: string;
  labelText: string;
  handleFill: string;
};

export type RulerDetectionResult = {
  schema: "fringelab.ruler-detection.v1";
  status: Exclude<RulerDetectionStatus, "idle" | "detecting" | "stale">;
  sourceWidth: number;
  sourceHeight: number;
  sourceType: "camera" | "image";
  selectedRegion: RulerRegion;
  rulerBodyCorners: [Point, Point, Point, Point];
  angleDeg: number;
  tickSide: 1 | -1;
  start: Point;
  end: Point;
  ticks: DetectedRulerTick[];
  numbers: DetectedRulerNumber[];
  fit: RulerFitStatistics;
  perspectiveVariationPct: number;
  perspectiveWarning: string | null;
  ocrStatus: "recognized" | "partial" | "not-found";
  manualOriginMm: number | null;
  contrastMode: RulerContrastMode;
  theme: RulerTheme;
  tickSnapEnabled: boolean;
  numberSnapEnabled: boolean;
  createdAt: string;
  message: string;
};

export type RobustTickFit = RulerFitStatistics & {
  indices: number[];
  inliers: boolean[];
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const quantile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(fraction, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

const standardDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
};

function grayAt(image: ImageDataLike, x: number, y: number): number {
  const boundedX = clamp(Math.round(x), 0, image.width - 1);
  const boundedY = clamp(Math.round(y), 0, image.height - 1);
  const offset = (boundedY * image.width + boundedX) * 4;
  return image.data[offset] * 0.2126 + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722;
}

function pointAlong(centre: Point, axis: Point, normal: Point, u: number, v: number): Point {
  return {
    x: centre.x + axis.x * u + normal.x * v,
    y: centre.y + axis.y * u + normal.y * v,
  };
}

export function resolveRulerThemeFromSamples(
  samples: readonly number[],
  requestedMode: RulerContrastMode = "auto",
): RulerTheme {
  const luminance = median(samples);
  const localContrast = quantile(samples, 0.9) - quantile(samples, 0.1);
  const complexBackground = localContrast >= 74;
  const resolvedMode: ResolvedRulerContrast = requestedMode === "auto"
    ? luminance >= 145 ? "dark-on-light" : "light-on-dark"
    : requestedMode;

  const palette: Record<ResolvedRulerContrast, Omit<RulerTheme, "requestedMode" | "resolvedMode" | "sampledLuminance" | "localContrast" | "complexBackground">> = {
    "dark-on-light": {
      stroke: "#071019",
      outline: "rgba(255,255,255,.96)",
      fill: "rgba(255,255,255,.12)",
      labelFill: "rgba(255,255,255,.88)",
      labelText: "#071019",
      handleFill: "#ffffff",
    },
    "light-on-dark": {
      stroke: "#f4fbff",
      outline: "rgba(2,8,14,.98)",
      fill: "rgba(3,14,22,.22)",
      labelFill: "rgba(3,10,16,.88)",
      labelText: "#f4fbff",
      handleFill: "#071019",
    },
    cyan: {
      stroke: "#59f4e0",
      outline: "rgba(2,8,14,.98)",
      fill: "rgba(89,244,224,.09)",
      labelFill: "rgba(2,12,18,.9)",
      labelText: "#8ffff0",
      handleFill: "#071019",
    },
    magenta: {
      stroke: "#ff5bd7",
      outline: "rgba(255,255,255,.98)",
      fill: "rgba(255,91,215,.09)",
      labelFill: "rgba(25,4,22,.9)",
      labelText: "#ff9ee8",
      handleFill: "#160512",
    },
  };

  return {
    requestedMode,
    resolvedMode,
    sampledLuminance: luminance,
    localContrast,
    complexBackground,
    ...palette[resolvedMode],
  };
}

export function sampleRulerBackground(
  image: ImageDataLike,
  ruler: RulerCalibration,
  sampleCount = 72,
): number[] {
  const deltaX = ruler.end.x - ruler.start.x;
  const deltaY = ruler.end.y - ruler.start.y;
  const length = Math.hypot(deltaX, deltaY);
  if (!Number.isFinite(length) || length < 1) return [];
  const axis = { x: deltaX / length, y: deltaY / length };
  const normal = { x: -axis.y, y: axis.x };
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const fraction = (index + 0.5) / sampleCount;
    const base = {
      x: ruler.start.x + deltaX * fraction,
      y: ruler.start.y + deltaY * fraction,
    };
    for (const offset of [-34, -19, -6, 6, 19, 34]) {
      samples.push(grayAt(image, base.x + normal.x * offset, base.y + normal.y * offset));
    }
  }
  return samples;
}

export function resolveRulerTheme(
  image: ImageDataLike,
  ruler: RulerCalibration,
  requestedMode: RulerContrastMode = "auto",
): RulerTheme {
  return resolveRulerThemeFromSamples(sampleRulerBackground(image, ruler), requestedMode);
}

export function snapThresholdPx(displayScale: number): number {
  const safeScale = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;
  return clamp(6 / safeScale, 3, 15);
}

/**
 * Fits tickPositionPx = offsetPx + pixelsPerMm * millimetreIndex.
 * Missing ticks are permitted because integer indices are inferred from the
 * median fundamental spacing; a MAD gate rejects spurious edge peaks.
 */
export function fitRulerTicksRobust(
  rawPositions: readonly number[],
  approximatePixelsPerMm?: number,
): RobustTickFit | null {
  const positions = [...rawPositions]
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .filter((value, index, array) => index === 0 || value - array[index - 1] > 0.75);
  if (positions.length < 4) return null;
  const differences = positions.slice(1).map((position, index) => position - positions[index]);
  let period = approximatePixelsPerMm && approximatePixelsPerMm > 1
    ? approximatePixelsPerMm
    : quantile(differences.filter((value) => value >= 1.5), 0.35);
  if (!Number.isFinite(period) || period < 1.5) return null;

  // Search nearby divisors/multiples and choose the period that explains the
  // greatest number of observed peaks with the smallest wrapped residual.
  const candidates = new Set<number>();
  for (const difference of differences) {
    for (let divisor = 1; divisor <= 6; divisor += 1) {
      const candidate = difference / divisor;
      if (candidate >= 1.5 && candidate <= Math.max(90, period * 6)) candidates.add(candidate);
    }
  }
  candidates.add(period);
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const wrapped = differences.map((difference) => {
      const multiple = Math.max(1, Math.round(difference / candidate));
      return Math.abs(difference - multiple * candidate) / candidate;
    });
    const explained = wrapped.filter((value) => value < 0.22).length;
    const candidateIndices = positions.map((position) => Math.round((position - positions[0]) / candidate));
    const candidateSpan = Math.max(...candidateIndices) - Math.min(...candidateIndices) + 1;
    const completeness = positions.length / Math.max(positions.length, candidateSpan);
    const prior = approximatePixelsPerMm
      ? -Math.abs(candidate - approximatePixelsPerMm) / approximatePixelsPerMm * 12
      : 0;
    // Prefer the largest fundamental that still explains the observations.
    // This prevents the two edges of one thick printed tick from being mistaken
    // for alternating millimetre ticks at half the real period.
    const score = explained * 2.2 + completeness * 34 - median(wrapped) * 2 + prior;
    if (score > bestScore) {
      bestScore = score;
      period = candidate;
    }
  }

  let indices = positions.map((position) => Math.round((position - positions[0]) / period));
  let inliers = positions.map(() => true);
  let offset = positions[0];
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const selected = positions.map((position, index) => ({ position, index: indices[index], use: inliers[index] }))
      .filter((item) => item.use);
    if (selected.length < 3) break;
    const meanIndex = selected.reduce((sum, item) => sum + item.index, 0) / selected.length;
    const meanPosition = selected.reduce((sum, item) => sum + item.position, 0) / selected.length;
    const denominator = selected.reduce((sum, item) => sum + (item.index - meanIndex) ** 2, 0);
    const slope = denominator > 0
      ? selected.reduce((sum, item) => sum + (item.index - meanIndex) * (item.position - meanPosition), 0) / denominator
      : period;
    if (slope > 1) period = slope;
    offset = meanPosition - period * meanIndex;
    indices = positions.map((position) => Math.round((position - offset) / period));
    const residuals = positions.map((position, index) => position - (offset + period * indices[index]));
    const residualMedian = median(residuals);
    const mad = median(residuals.map((value) => Math.abs(value - residualMedian)));
    const gate = Math.max(0.8, Math.min(period * 0.24, mad * 3 + 0.5));
    inliers = residuals.map((value) => Math.abs(value - residualMedian) <= gate);
  }

  const inlierResiduals = positions
    .map((position, index) => inliers[index] ? position - (offset + period * indices[index]) : null)
    .filter((value): value is number => value != null);
  const rms = Math.sqrt(inlierResiduals.reduce((sum, value) => sum + value ** 2, 0) /
    Math.max(1, inlierResiduals.length));
  const indexSpan = Math.max(...indices) - Math.min(...indices);
  const missingTickEstimate = Math.max(0, indexSpan + 1 - inliers.filter(Boolean).length);
  const coverage = inliers.filter(Boolean).length / positions.length;
  const regularity = clamp(1 - rms / Math.max(1, period * 0.34), 0, 1);
  const completeness = clamp(inliers.filter(Boolean).length / Math.max(6, indexSpan + 1), 0, 1);
  const confidence = clamp(coverage * 0.42 + regularity * 0.42 + completeness * 0.16, 0, 1);
  return {
    pixelsPerMm: period,
    mmPerPixel: 1 / period,
    offsetPx: offset,
    residualRmsPx: rms,
    inlierCount: inliers.filter(Boolean).length,
    totalCount: positions.length,
    missingTickEstimate,
    confidence,
    indices,
    inliers,
  };
}

export function classifyRulerTickLengths(lengths: readonly number[]): RulerTickKind[] {
  if (lengths.length === 0) return [];
  let centres = [Math.min(...lengths), median(lengths), Math.max(...lengths)];
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const groups: number[][] = [[], [], []];
    for (const length of lengths) {
      let best = 0;
      for (let index = 1; index < centres.length; index += 1) {
        if (Math.abs(length - centres[index]) < Math.abs(length - centres[best])) best = index;
      }
      groups[best].push(length);
    }
    centres = centres.map((centre, index) => groups[index].length
      ? groups[index].reduce((sum, value) => sum + value, 0) / groups[index].length
      : centre);
  }
  const order = centres.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  return lengths.map((length) => {
    let cluster = 0;
    for (let index = 1; index < centres.length; index += 1) {
      if (Math.abs(length - centres[index]) < Math.abs(length - centres[cluster])) cluster = index;
    }
    const rank = order.findIndex((item) => item.index === cluster);
    return rank === 2 && order[2].value > order[0].value * 1.25
      ? "major"
      : rank === 1 && order[1].value > order[0].value * 1.12 ? "medium" : "minor";
  });
}

export function associateOcrNumbers(
  numbers: readonly Omit<DetectedRulerNumber, "associatedMillimetreIndex">[],
  ticks: readonly Pick<DetectedRulerTick, "axisPositionPx" | "millimetreIndex" | "kind">[],
  maximumDistancePx: number,
): DetectedRulerNumber[] {
  return numbers.map((number) => {
    const candidates = ticks.filter((tick) => tick.kind === "major");
    const nearest = candidates.reduce<typeof candidates[number] | null>((best, tick) => {
      if (!best) return tick;
      return Math.abs(tick.axisPositionPx - number.axisPositionPx) <
        Math.abs(best.axisPositionPx - number.axisPositionPx) ? tick : best;
    }, null);
    return {
      ...number,
      associatedMillimetreIndex: nearest &&
        Math.abs(nearest.axisPositionPx - number.axisPositionPx) <= maximumDistancePx
        ? nearest.millimetreIndex
        : null,
    };
  });
}

export function validateOcrProgression(numbers: readonly DetectedRulerNumber[]): number {
  const associated = numbers
    .filter((item) => item.associatedMillimetreIndex != null)
    .sort((a, b) => a.axisPositionPx - b.axisPositionPx);
  if (associated.length < 2) return associated.length === 1 ? 0.35 : 0;
  let valid = 0;
  for (let index = 1; index < associated.length; index += 1) {
    const valueDirection = Math.sign(associated[index].value - associated[index - 1].value);
    const tickDirection = Math.sign(
      (associated[index].associatedMillimetreIndex ?? 0) -
      (associated[index - 1].associatedMillimetreIndex ?? 0),
    );
    if (valueDirection === tickDirection && valueDirection !== 0) valid += 1;
  }
  return valid / (associated.length - 1);
}

function smooth(values: readonly number[], radius = 1): number[] {
  return values.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const value = values[index + offset];
      if (value != null) {
        sum += value;
        count += 1;
      }
    }
    return count ? sum / count : 0;
  });
}

function rowEdgeScores(image: ImageDataLike): number[] {
  const step = Math.max(1, Math.floor(image.width / 720));
  const scores: number[] = [];
  for (let y = 1; y < image.height - 1; y += 1) {
    let edge = 0;
    let count = 0;
    for (let x = 2; x < image.width - 2; x += step) {
      edge += Math.abs(grayAt(image, x + 1, y) - grayAt(image, x - 1, y));
      count += 1;
    }
    scores[y] = count ? edge / count : 0;
  }
  return smooth(scores.map((value) => value ?? 0), 3);
}

function columnEdgeScores(image: ImageDataLike): number[] {
  const step = Math.max(1, Math.floor(image.height / 480));
  const scores: number[] = [];
  for (let x = 1; x < image.width - 1; x += 1) {
    let edge = 0;
    let count = 0;
    for (let y = 2; y < image.height - 2; y += step) {
      edge += Math.abs(grayAt(image, x, y + 1) - grayAt(image, x, y - 1));
      count += 1;
    }
    scores[x] = count ? edge / count : 0;
  }
  return smooth(scores.map((value) => value ?? 0), 3);
}

function bestWindow(values: readonly number[], minimumSize: number, maximumSize: number): { start: number; end: number; score: number } {
  const prefix = [0];
  for (const value of values) prefix.push(prefix[prefix.length - 1] + (value || 0));
  let best = { start: 0, end: Math.min(values.length, minimumSize), score: -Infinity };
  const sizes = new Set([
    minimumSize,
    Math.round((minimumSize + maximumSize) / 2),
    maximumSize,
  ].map((value) => clamp(value, 2, values.length)));
  for (const size of sizes) {
    for (let start = 0; start + size <= values.length; start += Math.max(1, Math.floor(size / 12))) {
      const average = (prefix[start + size] - prefix[start]) / size;
      if (average > best.score) best = { start, end: start + size, score: average };
    }
  }
  return best;
}

export function detectRulerRegion(image: ImageDataLike): RulerRegion | null {
  if (image.width < 80 || image.height < 50) return null;
  const rows = rowEdgeScores(image);
  const columns = columnEdgeScores(image);
  const horizontalBand = bestWindow(
    rows,
    Math.max(22, Math.round(image.height * 0.07)),
    Math.max(38, Math.round(image.height * 0.25)),
  );
  const verticalBand = bestWindow(
    columns,
    Math.max(22, Math.round(image.width * 0.07)),
    Math.max(38, Math.round(image.width * 0.25)),
  );

  if (horizontalBand.score >= verticalBand.score * 0.86) {
    const y0 = clamp(horizontalBand.start - 8, 0, image.height - 1);
    const y1 = clamp(horizontalBand.end + 8, y0 + 1, image.height);
    const brightness: number[] = [];
    for (let x = 0; x < image.width; x += 1) {
      const samples: number[] = [];
      for (let y = y0; y < y1; y += Math.max(2, Math.round((y1 - y0) / 12))) {
        samples.push(grayAt(image, x, y));
      }
      brightness[x] = median(samples);
    }
    const threshold = Math.max(42, quantile(brightness, 0.4));
    let bestRun = { start: 0, end: image.width, score: 0 };
    let runStart = -1;
    for (let x = 0; x <= image.width; x += 1) {
      if (x < image.width && brightness[x] >= threshold) {
        if (runStart < 0) runStart = x;
      } else if (runStart >= 0) {
        if (x - runStart > bestRun.score) bestRun = { start: runStart, end: x, score: x - runStart };
        runStart = -1;
      }
    }
    if (bestRun.score < image.width * 0.22) bestRun = { start: 0, end: image.width, score: image.width };
    return {
      x: clamp(bestRun.start - 10, 0, image.width - 1),
      y: y0,
      width: clamp(bestRun.end - bestRun.start + 20, 20, image.width - clamp(bestRun.start - 10, 0, image.width - 1)),
      height: y1 - y0,
    };
  }

  const x0 = clamp(verticalBand.start - 8, 0, image.width - 1);
  const x1 = clamp(verticalBand.end + 8, x0 + 1, image.width);
  return { x: x0, y: 0, width: x1 - x0, height: image.height };
}

function axialProfile(
  image: ImageDataLike,
  region: RulerRegion,
  angleRadians: number,
  normalStartFraction: number,
  normalEndFraction: number,
): { values: number[]; centre: Point; axis: Point; normal: Point; length: number; thickness: number } {
  const centre = { x: region.x + region.width / 2, y: region.y + region.height / 2 };
  const axis = { x: Math.cos(angleRadians), y: Math.sin(angleRadians) };
  const normal = { x: -axis.y, y: axis.x };
  const horizontal = Math.abs(axis.x) >= Math.abs(axis.y);
  const length = Math.max(20, horizontal ? region.width * 0.96 : region.height * 0.96);
  const thickness = Math.max(12, horizontal ? region.height * 0.82 : region.width * 0.82);
  const count = Math.max(20, Math.floor(length));
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const u = index - (count - 1) / 2;
    const samples: number[] = [];
    const v0 = (normalStartFraction - 0.5) * thickness;
    const v1 = (normalEndFraction - 0.5) * thickness;
    const normalSamples = Math.max(6, Math.min(32, Math.round(Math.abs(v1 - v0))));
    for (let sample = 0; sample < normalSamples; sample += 1) {
      const v = v0 + (v1 - v0) * (sample + 0.5) / normalSamples;
      const point = pointAlong(centre, axis, normal, u, v);
      samples.push(grayAt(image, point.x, point.y));
    }
    const centreValue = median(samples);
    const meanValue = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
    const range = quantile(samples, 0.86) - quantile(samples, 0.14);
    // A correctly oriented tick occupies a persistent fraction of the sampled
    // normal line, shifting its mean away from the robust local median. A
    // slanted crossing only affects one or two samples.
    values.push(Math.abs(meanValue - centreValue) + range * 0.16);
  }
  return { values, centre, axis, normal, length: count, thickness };
}

function profileSharpness(values: readonly number[]): number {
  const smoothed = smooth(values, 1);
  const baseline = median(smoothed);
  const upper = quantile(smoothed, 0.92);
  return (upper - baseline) / Math.max(1, standardDeviation(smoothed));
}

export function estimateRulerAngle(image: ImageDataLike, region: RulerRegion): number {
  const horizontal = region.width >= region.height;
  const centre = horizontal ? 0 : 90;
  let best = { angle: centre, score: -Infinity };
  for (let angle = centre - 22; angle <= centre + 22; angle += 1) {
    const radians = angle * Math.PI / 180;
    const axis = { x: Math.cos(radians), y: Math.sin(radians) };
    const normal = { x: -axis.y, y: axis.x };
    const regionCentre = { x: region.x + region.width / 2, y: region.y + region.height / 2 };
    const length = horizontal ? region.width * 0.88 : region.height * 0.88;
    const thickness = horizontal ? region.height * 0.9 : region.width * 0.9;
    let persistentEdge = 0;
    for (let v = -thickness / 2; v <= thickness / 2; v += 2) {
      let edgeSum = 0;
      let count = 0;
      for (let sample = 0; sample < 96; sample += 1) {
        const u = (sample / 95 - 0.5) * length;
        const point = pointAlong(regionCentre, axis, normal, u, v);
        edgeSum += Math.abs(
          grayAt(image, point.x + normal.x * 2, point.y + normal.y * 2) -
          grayAt(image, point.x - normal.x * 2, point.y - normal.y * 2),
        );
        count += 1;
      }
      persistentEdge = Math.max(persistentEdge, edgeSum / Math.max(1, count));
    }
    const top = axialProfile(image, region, radians, 0.02, 0.48);
    const bottom = axialProfile(image, region, radians, 0.52, 0.98);
    const score = persistentEdge * 0.82 +
      Math.max(profileSharpness(top.values), profileSharpness(bottom.values)) * 2.5;
    if (score > best.score) best = { angle, score };
  }
  return best.angle;
}

function detectProfilePeaks(values: readonly number[]): number[] {
  const filtered = smooth(values, 1);
  const baseline = median(filtered);
  const threshold = baseline + Math.max(
    3.2,
    (quantile(filtered, 0.98) - baseline) * 0.44,
    standardDeviation(filtered) * 0.9,
  );
  const candidates: Array<{ position: number; value: number }> = [];
  for (let index = 2; index < filtered.length - 2; index += 1) {
    if (filtered[index] >= threshold && filtered[index] >= filtered[index - 1] && filtered[index] > filtered[index + 1]) {
      candidates.push({ position: index, value: filtered[index] });
    }
  }
  candidates.sort((a, b) => b.value - a.value);
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (selected.every((item) => Math.abs(item.position - candidate.position) >= 3)) selected.push(candidate);
  }
  return selected.sort((a, b) => a.position - b.position).map((item) => item.position);
}

export function estimateRulerPeriodAutocorrelation(values: readonly number[]): number | null {
  if (values.length < 24) return null;
  const filtered = smooth(values, 1);
  const centre = median(filtered);
  const signal = filtered.map((value) => Math.max(0, value - centre));
  const energy = signal.reduce((sum, value) => sum + value * value, 0);
  if (energy <= Number.EPSILON) return null;
  const maximumLag = Math.min(60, Math.floor(signal.length / 5));
  const scores: number[] = [];
  for (let lag = 2; lag <= maximumLag; lag += 1) {
    let numerator = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = 0; index + lag < signal.length; index += 1) {
      numerator += signal[index] * signal[index + lag];
      leftEnergy += signal[index] ** 2;
      rightEnergy += signal[index + lag] ** 2;
    }
    scores[lag] = numerator / Math.sqrt(Math.max(Number.EPSILON, leftEnergy * rightEnergy));
  }
  const candidates: Array<{ lag: number; score: number }> = [];
  for (let lag = 3; lag < maximumLag; lag += 1) {
    if ((scores[lag] ?? 0) >= (scores[lag - 1] ?? 0) && (scores[lag] ?? 0) > (scores[lag + 1] ?? 0)) {
      candidates.push({ lag, score: scores[lag] });
    }
  }
  if (candidates.length === 0) return null;
  const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
  const plausible = candidates.filter((candidate) => candidate.score >= Math.max(0.16, bestScore * 0.62));
  if (plausible.length === 0) return null;
  // The first strong repeat is the 1 mm fundamental; later peaks are commonly
  // its 5 mm or 10 mm harmonics.
  return plausible.sort((left, right) => left.lag - right.lag)[0].lag;
}

function tickLengthAt(
  image: ImageDataLike,
  centre: Point,
  axis: Point,
  normal: Point,
  axisPosition: number,
  thickness: number,
): number {
  const samples: number[] = [];
  const half = thickness / 2;
  for (let v = -half; v <= half; v += 1) {
    const point = pointAlong(centre, axis, normal, axisPosition, v);
    const across = [-1, 0, 1].map((u) => grayAt(image, point.x + axis.x * u, point.y + axis.y * u));
    samples.push(median(across));
  }
  const lightBackground = median(samples) >= 128;
  const threshold = lightBackground ? quantile(samples, 0.38) : quantile(samples, 0.62);
  const active = samples.map((value) => lightBackground ? value <= threshold : value >= threshold);
  let longest = 0;
  let current = 0;
  for (const value of active) {
    current = value ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function perspectiveVariation(positions: readonly number[], period: number): number {
  if (positions.length < 8 || period <= 0) return 0;
  const differences = positions.slice(1).map((position, index) => position - positions[index]);
  const middle = Math.floor(differences.length / 2);
  const left = median(differences.slice(0, middle).filter((value) => value < period * 1.8));
  const right = median(differences.slice(middle).filter((value) => value < period * 1.8));
  if (!left || !right) return 0;
  return Math.abs(left - right) / ((left + right) / 2) * 100;
}

export function detectPhysicalRuler(
  image: ImageDataLike,
  options: {
    sourceType: "camera" | "image";
    region?: RulerRegion;
    contrastMode?: RulerContrastMode;
    tickSnapEnabled?: boolean;
    numberSnapEnabled?: boolean;
    manualOriginMm?: number | null;
  },
): RulerDetectionResult | null {
  const region = options.region ?? detectRulerRegion(image);
  if (!region || region.width < 30 || region.height < 20) return null;
  const angleDeg = estimateRulerAngle(image, region);
  const radians = angleDeg * Math.PI / 180;
  const top = axialProfile(image, region, radians, 0.02, 0.5);
  const bottom = axialProfile(image, region, radians, 0.5, 0.98);
  const topScore = profileSharpness(top.values);
  const bottomScore = profileSharpness(bottom.values);
  const selected = topScore >= bottomScore ? top : bottom;
  const tickSide: 1 | -1 = topScore >= bottomScore ? 1 : -1;
  const positions = detectProfilePeaks(selected.values);
  const selectedPositions = positions.map((position) => position - (selected.length - 1) / 2);
  const lengths = selectedPositions.map((position) => tickLengthAt(
    image,
    selected.centre,
    selected.axis,
    selected.normal,
    position,
    selected.thickness,
  ));
  const classified = classifyRulerTickLengths(lengths);
  const profilePeriod = estimateRulerPeriodAutocorrelation(selected.values);
  const majorPositions = positions.filter((_, index) => classified[index] === "major");
  const structuralPeriods: number[] = [];
  for (let index = 1; index < majorPositions.length; index += 1) {
    const estimate = (majorPositions[index] - majorPositions[index - 1]) / 10;
    if (estimate >= 2 && estimate <= 24) structuralPeriods.push(estimate);
  }
  const mediumPositions = positions.filter((_, index) => classified[index] !== "minor");
  for (let index = 1; index < mediumPositions.length; index += 1) {
    const estimate = (mediumPositions[index] - mediumPositions[index - 1]) / 5;
    if (estimate >= 2 && estimate <= 24) structuralPeriods.push(estimate);
  }
  const structuralPeriod = structuralPeriods.length >= 2 ? median(structuralPeriods) : null;
  const structuralRatio = structuralPeriod && profilePeriod ? structuralPeriod / profilePeriod : null;
  const approximatePeriod = structuralPeriod && profilePeriod && structuralRatio != null &&
    structuralRatio >= 0.58 && structuralRatio <= 1.72
    ? structuralPeriod
    : profilePeriod ?? structuralPeriod;
  const fit = fitRulerTicksRobust(positions, approximatePeriod ?? undefined);
  if (!fit || fit.inlierCount < 4 || fit.pixelsPerMm < 1.5) return null;
  const baselineV = tickSide === 1 ? -selected.thickness * 0.48 : selected.thickness * 0.48;
  const ticks: DetectedRulerTick[] = selectedPositions.map((position, index) => ({
    point: pointAlong(selected.centre, selected.axis, selected.normal, position, baselineV),
    axisPositionPx: positions[index],
    millimetreIndex: fit.indices[index] - Math.min(...fit.indices),
    lengthPx: lengths[index],
    kind: classified[index],
    inlier: fit.inliers[index],
  }));
  // Ensure every tenth fitted index remains a major magnetic anchor even when
  // blur makes the observed line length ambiguous.
  for (const tick of ticks) {
    if (tick.millimetreIndex % 10 === 0) tick.kind = "major";
    else if (tick.millimetreIndex % 5 === 0 && tick.kind === "minor") tick.kind = "medium";
  }
  const inlierTicks = ticks.filter((tick) => tick.inlier);
  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  if (!first || !last || inlierTicks.length < 4 || last.axisPositionPx <= first.axisPositionPx) return null;
  // Cover the complete detected ruler body, not merely the subset of ticks
  // that survived the robust inlier gate. This gives the user a useful full
  // overlay even when blur or occlusion leaves only part of the tick series.
  const start = pointAlong(selected.centre, selected.axis, selected.normal, -selected.length / 2, baselineV);
  const end = pointAlong(selected.centre, selected.axis, selected.normal, selected.length / 2, baselineV);
  const knownLengthMm = Math.max(1, Math.round(selected.length / fit.pixelsPerMm));
  const themeRuler: RulerCalibration = { start, end, knownLengthMm, tickSide };
  const contrastMode = options.contrastMode ?? "auto";
  const theme = resolveRulerTheme(image, themeRuler, contrastMode);
  const variation = perspectiveVariation(positions.filter((_, index) => fit.inliers[index]), fit.pixelsPerMm);
  const perspectiveWarning = variation > 3
    ? `左右毫米间距变化 ${variation.toFixed(1)}%，存在透视；当前仅警告降级，未进行单应性校正。`
    : null;
  const status = perspectiveWarning || fit.confidence < 0.55 ? "degraded" : "ready";
  const halfLength = selected.length / 2;
  const halfThickness = selected.thickness / 2;
  const corners: [Point, Point, Point, Point] = [
    pointAlong(selected.centre, selected.axis, selected.normal, -halfLength, -halfThickness),
    pointAlong(selected.centre, selected.axis, selected.normal, halfLength, -halfThickness),
    pointAlong(selected.centre, selected.axis, selected.normal, halfLength, halfThickness),
    pointAlong(selected.centre, selected.axis, selected.normal, -halfLength, halfThickness),
  ];
  return {
    schema: "fringelab.ruler-detection.v1",
    status,
    sourceWidth: image.width,
    sourceHeight: image.height,
    sourceType: options.sourceType,
    selectedRegion: region,
    rulerBodyCorners: corners,
    angleDeg,
    tickSide,
    start,
    end,
    ticks,
    numbers: [],
    fit: {
      pixelsPerMm: fit.pixelsPerMm,
      mmPerPixel: fit.mmPerPixel,
      offsetPx: fit.offsetPx,
      residualRmsPx: fit.residualRmsPx,
      inlierCount: fit.inlierCount,
      totalCount: fit.totalCount,
      missingTickEstimate: fit.missingTickEstimate,
      confidence: perspectiveWarning ? fit.confidence * 0.78 : fit.confidence,
    },
    perspectiveVariationPct: variation,
    perspectiveWarning,
    ocrStatus: "not-found",
    manualOriginMm: options.manualOriginMm ?? null,
    contrastMode,
    theme,
    tickSnapEnabled: options.tickSnapEnabled ?? true,
    numberSnapEnabled: options.numberSnapEnabled ?? true,
    createdAt: new Date().toISOString(),
    message: `识别 ${fit.inlierCount}/${fit.totalCount} 条刻线，周期 ${fit.pixelsPerMm.toFixed(2)} px/mm` +
      `${profilePeriod ? `（投影 ${profilePeriod.toFixed(1)}` : ""}${structuralPeriod ? `${profilePeriod ? "，" : "（"}长刻线 ${structuralPeriod.toFixed(1)}` : ""}${profilePeriod || structuralPeriod ? "）" : ""}` +
      "；数字未确认，可输入起始刻度。",
  };
}

export function rulerFromDetection(result: RulerDetectionResult): RulerCalibration {
  const pixelLength = Math.hypot(result.end.x - result.start.x, result.end.y - result.start.y);
  const knownLengthMm = Math.max(1, Math.round(pixelLength * result.fit.mmPerPixel));
  return {
    start: result.start,
    end: result.end,
    knownLengthMm,
    tickSide: result.tickSide,
    originMm: result.manualOriginMm ?? undefined,
  };
}

export function snapRulerToDetection(
  ruler: RulerCalibration,
  result: RulerDetectionResult,
  options: {
    tickSnapEnabled: boolean;
    numberSnapEnabled: boolean;
    displayScale?: number;
    altKey?: boolean;
  },
): { ruler: RulerCalibration; snapped: boolean; target: "edge" | "tick" | "number" | null; distancePx: number } {
  if (options.altKey) return { ruler, snapped: false, target: null, distancePx: Infinity };
  const threshold = snapThresholdPx(options.displayScale ?? 1);
  const detectionRuler = rulerFromDetection(result);
  const distances = [
    Math.hypot(ruler.start.x - detectionRuler.start.x, ruler.start.y - detectionRuler.start.y),
    Math.hypot(ruler.end.x - detectionRuler.end.x, ruler.end.y - detectionRuler.end.y),
  ];
  const reversedDistances = [
    Math.hypot(ruler.start.x - detectionRuler.end.x, ruler.start.y - detectionRuler.end.y),
    Math.hypot(ruler.end.x - detectionRuler.start.x, ruler.end.y - detectionRuler.start.y),
  ];
  const direct = distances[0] + distances[1];
  const reversed = reversedDistances[0] + reversedDistances[1];
  const averageDistance = Math.min(direct, reversed) / 2;
  if (averageDistance <= Math.max(threshold, 18)) {
    const next = reversed < direct
      ? { ...detectionRuler, start: detectionRuler.end, end: detectionRuler.start, tickSide: (detectionRuler.tickSide === 1 ? -1 : 1) as 1 | -1 }
      : detectionRuler;
    return { ruler: next, snapped: true, target: "edge", distancePx: averageDistance };
  }
  if (!options.tickSnapEnabled && !options.numberSnapEnabled) {
    return { ruler, snapped: false, target: null, distancePx: averageDistance };
  }
  // A recognized physical ruler is itself the most reliable tick/number anchor.
  // Manual movement within the magnetic threshold adopts its robust fitted axis.
  const midpoint = {
    x: (ruler.start.x + ruler.end.x) / 2,
    y: (ruler.start.y + ruler.end.y) / 2,
  };
  const targetMidpoint = {
    x: (result.start.x + result.end.x) / 2,
    y: (result.start.y + result.end.y) / 2,
  };
  const midpointDistance = Math.hypot(midpoint.x - targetMidpoint.x, midpoint.y - targetMidpoint.y);
  if (midpointDistance <= threshold * 2.5) {
    return {
      ruler: detectionRuler,
      snapped: true,
      target: options.numberSnapEnabled && result.numbers.length > 0 ? "number" : "tick",
      distancePx: midpointDistance,
    };
  }
  return { ruler, snapped: false, target: null, distancePx: midpointDistance };
}

export function clientPointToImagePoint(
  client: Point,
  canvasRect: { left: number; top: number; width: number; height: number },
  imageSize: { width: number; height: number },
): Point {
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp((client.x - canvasRect.left) / canvasRect.width * imageSize.width, 0, imageSize.width),
    y: clamp((client.y - canvasRect.top) / canvasRect.height * imageSize.height, 0, imageSize.height),
  };
}

export type RulerSourceSignature = {
  sourceType: "camera" | "image";
  sourceId: string;
  width: number;
  height: number;
  zoom: number;
  cropKey: string;
  orientationDeg: number;
  perspectiveKey: string;
};

export function shouldMarkCalibrationStale(
  calibrationMethod: "manual-scale" | "two-point" | "physical-ruler-overlay" | "physical-ruler-perspective",
  previous: RulerSourceSignature,
  next: RulerSourceSignature,
): boolean {
  if (calibrationMethod === "manual-scale" || calibrationMethod === "two-point") return false;
  return previous.sourceType !== next.sourceType ||
    previous.sourceId !== next.sourceId ||
    previous.width !== next.width ||
    previous.height !== next.height ||
    previous.zoom !== next.zoom ||
    previous.cropKey !== next.cropKey ||
    previous.orientationDeg !== next.orientationDeg ||
    previous.perspectiveKey !== next.perspectiveKey;
}
