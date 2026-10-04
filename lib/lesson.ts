import { mapScreenPointMm, type SpatialAnchor } from "./spatial.ts";
import type { Point } from "./roi";

/** Student-selected bright centres, not detector maxima. N means intervals. */
export function calculateFringeExercise(points: readonly Point[], intervals: number, mmPerPixel: number, axisAngleDeg: number, dMm: number, distanceM: number, anchors: SpatialAnchor[] = []) {
  if (points.length !== 2 || !Number.isInteger(intervals) || intervals < 1 || intervals > 30 || !(mmPerPixel > 0 && dMm > 0 && distanceM > 0)) return null;
  const angle = axisAngleDeg * Math.PI / 180;
  const spanPx = Math.abs((points[1].x - points[0].x) * Math.cos(angle) + (points[1].y - points[0].y) * Math.sin(angle));
  const spanMm = anchors.length >= 3 ? Math.abs(mapScreenPointMm(points[1], anchors) - mapScreenPointMm(points[0], anchors)) : spanPx * mmPerPixel;
  if (!Number.isFinite(spanMm) || spanMm <= 0 || spanPx < 3) return null;
  const spacingMm = spanMm / intervals;
  return { spanPx, spanMm, spacingMm, wavelengthNm: dMm * spacingMm / distanceM * 1000 };
}

export function checkExerciseAnswer(input: string, expected: number | null): "empty" | "invalid" | "correct" | "retry" {
  if (!input.trim()) return "empty";
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0 || expected == null) return "invalid";
  return Math.abs(value - expected) <= Math.max(Math.abs(expected) * .02, .005) ? "correct" : "retry";
}
