import type { Point } from "./roi";

export type SpatialAnchor = Point & { mm: number };

/** One-dimensional ruler mapping in the screen plane; not a 2D homography. */
export function validateSpatialAnchors(anchors: readonly SpatialAnchor[]): { valid: boolean; variationPct: number; reason: string } {
  if (anchors.length < 3) return { valid: false, variationPct: 0, reason: "至少需要3个尺标点" };
  if (anchors.some((p) => ![p.x, p.y, p.mm].every(Number.isFinite))) return { valid: false, variationPct: 0, reason: "尺标数据无效" };
  const sorted = [...anchors].sort((a, b) => a.mm - b.mm);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const length = Math.hypot(last.x - first.x, last.y - first.y);
  if (length < 20) return { valid: false, variationPct: 0, reason: "尺标跨度太短" };
  const axis = { x: (last.x - first.x) / length, y: (last.y - first.y) / length };
  const distances = sorted.map((p) => (p.x - first.x) * axis.x + (p.y - first.y) * axis.y);
  const scales: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].mm <= sorted[i - 1].mm || distances[i] - distances[i - 1] < 3) return { valid: false, variationPct: 0, reason: "读数须不同，点位须沿尺子顺序排列" };
    scales.push((distances[i] - distances[i - 1]) / (sorted[i].mm - sorted[i - 1].mm));
  }
  const offAxis = sorted.map((p) => Math.abs(-(p.x - first.x) * axis.y + (p.y - first.y) * axis.x));
  if (Math.max(...offAxis) > Math.max(4, length * 0.02)) return { valid: false, variationPct: 0, reason: "请点击同一排刻线的同一高度" };
  const average = scales.reduce((a, b) => a + b, 0) / scales.length;
  return { valid: true, variationPct: (Math.max(...scales) - Math.min(...scales)) / average * 100, reason: "分段尺标映射有效；应另选独立刻度校验" };
}

export function mapScreenPointMm(point: Point, anchors: readonly SpatialAnchor[]): number {
  const sorted = [...anchors].sort((a, b) => a.mm - b.mm);
  if (sorted.length < 2) throw new RangeError("At least two anchors required");
  const first = sorted[0], last = sorted[sorted.length - 1];
  const length = Math.hypot(last.x - first.x, last.y - first.y);
  if (!(length > 0)) throw new RangeError("Coincident anchors");
  const ax = (last.x - first.x) / length, ay = (last.y - first.y) / length;
  const q = (point.x - first.x) * ax + (point.y - first.y) * ay;
  const positions = sorted.map((p) => (p.x - first.x) * ax + (p.y - first.y) * ay);
  let i = positions.findIndex((x) => x > q) - 1;
  if (i === -2) i = positions.length - 2;
  i = Math.max(0, Math.min(positions.length - 2, i));
  return sorted[i].mm + (q - positions[i]) / (positions[i + 1] - positions[i]) * (sorted[i + 1].mm - sorted[i].mm);
}
