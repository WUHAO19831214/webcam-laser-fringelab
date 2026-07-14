import type { Point } from "./roi";
import type { ImageDataLike } from "./signal";

export type RulerCalibration = {
  start: Point;
  end: Point;
  knownLengthMm: number;
  /** Tick direction in ruler-local coordinates. -1 draws above the baseline. */
  tickSide?: 1 | -1;
  /** Optional absolute value at the first virtual tick; scale does not depend on it. */
  originMm?: number;
};

export type RulerHandle = "start" | "end" | "body";
export type RulerTickKind = "minor" | "medium" | "major";

export type RulerTick = {
  millimetre: number;
  point: Point;
  kind: RulerTickKind;
};

export type RulerAlignmentSuggestion = {
  ruler: RulerCalibration;
  confidence: number;
  normalShiftPx: number;
  angleCorrectionDeg: number;
};

const MIN_RULER_LENGTH_PX = 1e-6;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function rulerLengthPx(ruler: RulerCalibration): number {
  if (!finitePoint(ruler.start) || !finitePoint(ruler.end)) return Number.NaN;
  return Math.hypot(ruler.end.x - ruler.start.x, ruler.end.y - ruler.start.y);
}

export function rulerAngleDeg(ruler: RulerCalibration): number {
  return Math.atan2(ruler.end.y - ruler.start.y, ruler.end.x - ruler.start.x) * 180 / Math.PI;
}

export function calculateMmPerPixel(ruler: RulerCalibration): number | null {
  const pixelLength = rulerLengthPx(ruler);
  if (
    !Number.isFinite(pixelLength) ||
    pixelLength < MIN_RULER_LENGTH_PX ||
    !Number.isFinite(ruler.knownLengthMm) ||
    ruler.knownLengthMm <= 0
  ) {
    return null;
  }
  return ruler.knownLengthMm / pixelLength;
}

export function calculateCalibrationUncertaintyPct(
  ruler: RulerCalibration,
  endpointStandardUncertaintyPx = 0.5,
): number | null {
  const pixelLength = rulerLengthPx(ruler);
  if (
    !Number.isFinite(pixelLength) ||
    pixelLength < MIN_RULER_LENGTH_PX ||
    !Number.isFinite(endpointStandardUncertaintyPx) ||
    endpointStandardUncertaintyPx < 0
  ) {
    return null;
  }
  return Math.SQRT2 * endpointStandardUncertaintyPx / pixelLength * 100;
}

export function generateRulerTicks(ruler: RulerCalibration): RulerTick[] {
  if (calculateMmPerPixel(ruler) == null) return [];
  const wholeMillimetres = Math.floor(ruler.knownLengthMm + 1e-9);
  const deltaX = ruler.end.x - ruler.start.x;
  const deltaY = ruler.end.y - ruler.start.y;
  const ticks: RulerTick[] = [];
  for (let millimetre = 0; millimetre <= wholeMillimetres; millimetre += 1) {
    const fraction = millimetre / ruler.knownLengthMm;
    ticks.push({
      millimetre,
      point: {
        x: ruler.start.x + deltaX * fraction,
        y: ruler.start.y + deltaY * fraction,
      },
      kind: millimetre % 10 === 0
        ? "major"
        : millimetre % 5 === 0 ? "medium" : "minor",
    });
  }
  return ticks;
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  if (lengthSquared <= Number.EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const fraction = clamp(
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared,
    0,
    1,
  );
  return Math.hypot(
    point.x - (start.x + fraction * deltaX),
    point.y - (start.y + fraction * deltaY),
  );
}

export function hitTestRuler(
  ruler: RulerCalibration,
  point: Point,
  handleRadiusPx = 18,
  bodyTolerancePx = 22,
): RulerHandle | null {
  if (Math.hypot(point.x - ruler.start.x, point.y - ruler.start.y) <= handleRadiusPx) {
    return "start";
  }
  if (Math.hypot(point.x - ruler.end.x, point.y - ruler.end.y) <= handleRadiusPx) {
    return "end";
  }
  return distanceToSegment(point, ruler.start, ruler.end) <= bodyTolerancePx ? "body" : null;
}

export function moveRuler(
  ruler: RulerCalibration,
  deltaX: number,
  deltaY: number,
  bounds?: { width: number; height: number },
): RulerCalibration {
  let boundedX = Number.isFinite(deltaX) ? deltaX : 0;
  let boundedY = Number.isFinite(deltaY) ? deltaY : 0;
  if (bounds) {
    boundedX = clamp(
      boundedX,
      -Math.min(ruler.start.x, ruler.end.x),
      bounds.width - Math.max(ruler.start.x, ruler.end.x),
    );
    boundedY = clamp(
      boundedY,
      -Math.min(ruler.start.y, ruler.end.y),
      bounds.height - Math.max(ruler.start.y, ruler.end.y),
    );
  }
  return {
    ...ruler,
    start: { x: ruler.start.x + boundedX, y: ruler.start.y + boundedY },
    end: { x: ruler.end.x + boundedX, y: ruler.end.y + boundedY },
  };
}

export function resizeRulerEndpoint(
  ruler: RulerCalibration,
  handle: "start" | "end",
  pointer: Point,
  snapAngleDeg?: number,
): RulerCalibration {
  const fixed = handle === "start" ? ruler.end : ruler.start;
  let next = { ...pointer };
  if (snapAngleDeg && snapAngleDeg > 0) {
    const deltaX = pointer.x - fixed.x;
    const deltaY = pointer.y - fixed.y;
    const length = Math.hypot(deltaX, deltaY);
    const angle = Math.atan2(deltaY, deltaX);
    const increment = snapAngleDeg * Math.PI / 180;
    const snapped = Math.round(angle / increment) * increment;
    next = {
      x: fixed.x + Math.cos(snapped) * length,
      y: fixed.y + Math.sin(snapped) * length,
    };
  }
  return handle === "start"
    ? { ...ruler, start: next }
    : { ...ruler, end: next };
}

function sampleGray(image: ImageDataLike, x: number, y: number): number {
  const boundedX = clamp(Math.round(x), 0, image.width - 1);
  const boundedY = clamp(Math.round(y), 0, image.height - 1);
  const offset = (boundedY * image.width + boundedX) * 4;
  return image.data[offset] * 0.2126 + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722;
}

/**
 * Lightweight local ruler-axis suggestion. It searches near the user's ruler
 * for two persistent parallel edges and never applies the result on its own.
 */
export function suggestRulerAlignment(
  image: ImageDataLike,
  ruler: RulerCalibration,
): RulerAlignmentSuggestion | null {
  const length = rulerLengthPx(ruler);
  if (!Number.isFinite(length) || length < 80 || image.width < 2 || image.height < 2) return null;
  const midpoint = {
    x: (ruler.start.x + ruler.end.x) / 2,
    y: (ruler.start.y + ruler.end.y) / 2,
  };
  const initialAngle = Math.atan2(ruler.end.y - ruler.start.y, ruler.end.x - ruler.start.x);
  const candidateScores: Array<{
    angle: number;
    score: number;
    centreOffset: number;
  }> = [];
  const samples = Math.max(32, Math.min(120, Math.round(length / 5)));

  for (let correctionDeg = -10; correctionDeg <= 10; correctionDeg += 1) {
    const angle = initialAngle + correctionDeg * Math.PI / 180;
    const axis = { x: Math.cos(angle), y: Math.sin(angle) };
    const normal = { x: -axis.y, y: axis.x };
    const edgeScores: Array<{ offset: number; score: number }> = [];
    for (let normalOffset = -34; normalOffset <= 34; normalOffset += 2) {
      let score = 0;
      for (let index = 0; index < samples; index += 1) {
        const along = (index / Math.max(1, samples - 1) - 0.5) * length * 0.92;
        const x = midpoint.x + axis.x * along + normal.x * normalOffset;
        const y = midpoint.y + axis.y * along + normal.y * normalOffset;
        score += Math.abs(
          sampleGray(image, x + normal.x * 2, y + normal.y * 2) -
          sampleGray(image, x - normal.x * 2, y - normal.y * 2),
        );
      }
      edgeScores.push({ offset: normalOffset, score: score / samples });
    }
    edgeScores.sort((left, right) => right.score - left.score);
    const first = edgeScores[0];
    const second = edgeScores.find((candidate) => Math.abs(candidate.offset - first.offset) >= 8);
    if (first && second) {
      candidateScores.push({
        angle,
        score: (first.score + second.score) / 2,
        centreOffset: (first.offset + second.offset) / 2,
      });
    }
  }

  candidateScores.sort((left, right) => right.score - left.score);
  const best = candidateScores[0];
  if (!best || best.score < 3) return null;
  const typical = candidateScores.reduce((sum, candidate) => sum + candidate.score, 0) /
    candidateScores.length;
  const confidence = clamp((best.score - typical) / Math.max(4, best.score) * 3.5, 0, 1);
  if (confidence < 0.18) return null;

  const axis = { x: Math.cos(best.angle), y: Math.sin(best.angle) };
  const normal = { x: -axis.y, y: axis.x };
  const adjustedMidpoint = {
    x: midpoint.x + normal.x * best.centreOffset,
    y: midpoint.y + normal.y * best.centreOffset,
  };
  const halfLength = length / 2;
  return {
    ruler: {
      ...ruler,
      start: {
        x: adjustedMidpoint.x - axis.x * halfLength,
        y: adjustedMidpoint.y - axis.y * halfLength,
      },
      end: {
        x: adjustedMidpoint.x + axis.x * halfLength,
        y: adjustedMidpoint.y + axis.y * halfLength,
      },
    },
    confidence,
    normalShiftPx: best.centreOffset,
    angleCorrectionDeg: (best.angle - initialAngle) * 180 / Math.PI,
  };
}
