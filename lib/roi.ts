export type Point = { x: number; y: number };

export type RoiGeometry = {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  angleDeg: number;
};

export type RoiCorner = "nw" | "ne" | "se" | "sw";

export const ROI_CORNERS: readonly RoiCorner[] = ["nw", "ne", "se", "sw"];

const CORNER_SIGNS: Record<RoiCorner, readonly [number, number]> = {
  nw: [-1, -1],
  ne: [1, -1],
  se: [1, 1],
  sw: [-1, 1],
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
export function roiLocalToWorld(roi: RoiGeometry, local: Point): Point {
  const radians = roi.angleDeg * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: roi.centerX + local.x * cosine - local.y * sine,
    y: roi.centerY + local.x * sine + local.y * cosine,
  };
}

export function roiWorldToLocal(roi: RoiGeometry, point: Point): Point {
  const radians = roi.angleDeg * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const deltaX = point.x - roi.centerX;
  const deltaY = point.y - roi.centerY;
  return {
    x: deltaX * cosine + deltaY * sine,
    y: -deltaX * sine + deltaY * cosine,
  };
}

export function roiCornerPoint(roi: RoiGeometry, corner: RoiCorner): Point {
  const [signX, signY] = CORNER_SIGNS[corner];
  return roiLocalToWorld(roi, {
    x: signX * roi.width / 2,
    y: signY * roi.height / 2,
  });
}

export function hitTestRoiCorner(
  roi: RoiGeometry,
  point: Point,
  tolerancePx = 16,
): RoiCorner | null {
  let nearest: { corner: RoiCorner; distance: number } | null = null;
  for (const corner of ROI_CORNERS) {
    const handle = roiCornerPoint(roi, corner);
    const distance = Math.hypot(point.x - handle.x, point.y - handle.y);
    if (distance <= tolerancePx && (nearest == null || distance < nearest.distance)) {
      nearest = { corner, distance };
    }
  }
  return nearest?.corner ?? null;
}

export function isPointInsideRoi(roi: RoiGeometry, point: Point): boolean {
  const local = roiWorldToLocal(roi, point);
  return Math.abs(local.x) <= roi.width / 2 && Math.abs(local.y) <= roi.height / 2;
}

/** Resize from one corner while keeping the diagonally opposite corner fixed. */
export function resizeRoiFromCorner(
  roi: RoiGeometry,
  corner: RoiCorner,
  pointer: Point,
  limits: { minWidth: number; minHeight: number; maxWidth: number; maxHeight: number },
): RoiGeometry {
  const [signX, signY] = CORNER_SIGNS[corner];
  const opposite = roiLocalToWorld(roi, {
    x: -signX * roi.width / 2,
    y: -signY * roi.height / 2,
  });
  const reference: RoiGeometry = { ...roi, centerX: opposite.x, centerY: opposite.y };
  const delta = roiWorldToLocal(reference, pointer);
  const width = clamp(signX * delta.x, limits.minWidth, limits.maxWidth);
  const height = clamp(signY * delta.y, limits.minHeight, limits.maxHeight);
  const centreOffset = roiLocalToWorld(reference, {
    x: signX * width / 2,
    y: signY * height / 2,
  });
  return {
    ...roi,
    centerX: centreOffset.x,
    centerY: centreOffset.y,
    width,
    height,
  };
}

export function roiCornerCursor(corner: RoiCorner): "nwse-resize" | "nesw-resize" {
  return corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize";
}
