import type { Point, RoiGeometry } from "./roi";

type Center = { axisPx: number; position: number; saturated: boolean };

export function projectFringePoint(point: Point, roi: RoiGeometry, orientation: "vertical" | "horizontal"): number {
  const angle = (roi.angleDeg + (orientation === "horizontal" ? 90 : 0)) * Math.PI / 180;
  return (point.x - roi.centerX) * Math.cos(angle) + (point.y - roi.centerY) * Math.sin(angle);
}

export function snapToBrightFringe(point: Point, roi: RoiGeometry, orientation: "vertical" | "horizontal", peaks: readonly Center[], nativeToDisplay: number, periodPx: number | null) {
  if (!(nativeToDisplay > 0) || !peaks.length) return null;
  const axis = projectFringePoint(point, roi, orientation);
  const nearest = peaks.reduce((best, peak) => Math.abs(peak.axisPx * nativeToDisplay - axis) < Math.abs(best.axisPx * nativeToDisplay - axis) ? peak : best);
  // Stay within the local fringe: never jump to the globally brightest peak.
  const radius = periodPx && periodPx > 0 ? periodPx * nativeToDisplay * .48 : 18;
  if (Math.abs(nearest.axisPx * nativeToDisplay - axis) > radius) return null;
  const angle = (roi.angleDeg + (orientation === "horizontal" ? 90 : 0)) * Math.PI / 180;
  return { point: { x: roi.centerX + nearest.axisPx * nativeToDisplay * Math.cos(angle), y: roi.centerY + nearest.axisPx * nativeToDisplay * Math.sin(angle) }, peak: nearest };
}

export function profileIndexForPoint(point: Point, roi: RoiGeometry, orientation: "vertical" | "horizontal", axisPx: readonly number[], nativeToDisplay: number): number | null {
  if (axisPx.length < 2 || !(nativeToDisplay > 0)) return null;
  const target = projectFringePoint(point, roi, orientation) / nativeToDisplay;
  if (target < axisPx[0] || target > axisPx[axisPx.length - 1]) return null;
  for (let index = 1; index < axisPx.length; index++) {
    if (axisPx[index] >= target) return index - 1 + (target - axisPx[index - 1]) / (axisPx[index] - axisPx[index - 1]);
  }
  return axisPx.length - 1;
}
