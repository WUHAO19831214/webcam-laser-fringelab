import assert from "node:assert/strict";
import test from "node:test";

import { CHART_DISPLAY_CEILING, normalizeChartSeries } from "../lib/chart.ts";
import {
  hitTestRoiCorner,
  resizeRoiFromCorner,
  roiCornerPoint,
  type RoiGeometry,
} from "../lib/roi.ts";

test("chart normalisation always leaves two percent headroom", () => {
  const normalised = normalizeChartSeries([2, 4, 5, 100, 121]);
  assert.ok(normalised.every((value) => value >= 0 && value <= CHART_DISPLAY_CEILING));
  assert.equal(Math.max(...normalised), 0.98);
});
test("rotated ROI corners remain hittable", () => {
  const roi: RoiGeometry = { centerX: 480, centerY: 270, width: 600, height: 120, angleDeg: 18 };
  const northEast = roiCornerPoint(roi, "ne");
  assert.equal(hitTestRoiCorner(roi, { x: northEast.x + 4, y: northEast.y - 3 }, 10), "ne");
  assert.equal(hitTestRoiCorner(roi, { x: roi.centerX, y: roi.centerY }, 10), null);
});

test("corner resize changes both dimensions and anchors the opposite corner", () => {
  const roi: RoiGeometry = { centerX: 480, centerY: 270, width: 400, height: 100, angleDeg: 12 };
  const anchoredBefore = roiCornerPoint(roi, "nw");
  const southEast = roiCornerPoint(roi, "se");
  const resized = resizeRoiFromCorner(
    roi,
    "se",
    { x: southEast.x + 90, y: southEast.y + 45 },
    { minWidth: 80, minHeight: 24, maxWidth: 930, maxHeight: 420 },
  );
  const anchoredAfter = roiCornerPoint(resized, "nw");
  assert.ok(resized.width > roi.width);
  assert.ok(resized.height > roi.height);
  assert.ok(Math.hypot(anchoredAfter.x - anchoredBefore.x, anchoredAfter.y - anchoredBefore.y) < 1e-9);
});
