import { doubleSlitFresnelNumber, doubleSlitSmallAngleUncertainty, finiteDoubleSlitIntensity, fitDoubleSlitOrders, fitSingleSlitDarkFringes, singleSlitFresnelNumber, singleSlitIntensity, singleSlitSmallAngleUncertainty, weightedLinearRegression } from "./physics.ts";
import { calculateFwhm, detectPeaks, detectTroughs, estimatePeriodAutocorrelation, extractStripProfile, gaussianSmooth, subtractBackground, type DetectedExtremum, type FringeOrientation, type ImageDataLike, type RequestedProfileChannel } from "./signal.ts";
import { normalizeChartSeries } from "./chart.ts";
import { mapScreenPointMm, type SpatialAnchor } from "./spatial.ts";
import type { RoiGeometry as Roi } from "./roi";
type ExperimentMode = "double" | "single";
function clamp(value:number, minimum:number, maximum:number):number { return Math.max(minimum, Math.min(maximum,value)); }
export type Mark = DetectedExtremum & {
  axisPx: number;
  positionMm: number;
  order: number | null;
};

export type Analysis = {
  raw: number[];
  corrected: number[];
  smooth: number[];
  model: number[];
  axisPx: number[];
  axisMm: number[];
  peaks: Mark[];
  troughs: Mark[];
  selectedChannel: string;
  channelReason: string;
  saturationByChannel: Record<string, number>;
  provisional: boolean;
  measurementReady: boolean;
  warnings: string[];
  saturationRate: number;
  dynamicRange: number;
  periodPx: number | null;
  fringeSpacingMm: number | null;
  centralWidthMm: number | null;
  fwhmMm: number | null;
  wavelengthNm: number | null;
  smallAngleNm: number | null;
  uncertaintyNm: number | null;
  referenceErrorPct: number | null;
  smallAngleDifferencePct: number | null;
  regressionR2: number | null;
  fresnelNumber: number | null;
  centralPositionMm: number;
  status: string;
};

export type AnalysisConfig = {
  experiment: ExperimentMode;
  channel: RequestedProfileChannel;
  orientation: FringeOrientation;
  roi: Roi;
  mmPerPixel: number;
  screenDistanceM: number;
  slitWidthMm: number;
  slitSeparationMm: number;
  apertureUncertaintyMm: number;
  distanceUncertaintyM: number;
  calibrationUncertaintyPct: number;
  referenceWavelengthNm: number;
  smoothingSigma: number;
  background: number[] | null;
  spatialAnchors?: SpatialAnchor[];
  hasReference?: boolean;
  measurementReady?: boolean;
  slitWidthKnown?: boolean;
};

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function quantile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(fraction, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (values.length - 1),
  );
}

function markAtPosition(
  extremum: DetectedExtremum,
  axisPx: readonly number[],
  mmPerPixel: number,
): Mark {
  const bounded = clamp(extremum.position, 0, axisPx.length - 1);
  const lower = Math.floor(bounded);
  const upper = Math.ceil(bounded);
  const fraction = bounded - lower;
  const pixel = axisPx[lower] + (axisPx[upper] - axisPx[lower]) * fraction;
  return {
    ...extremum,
    axisPx: pixel,
    positionMm: pixel * mmPerPixel,
    order: null,
  };
}

export function analyseFrame(image: ImageDataLike, config: AnalysisConfig): Analysis {
  const extracted = extractStripProfile(image, {
    channel: config.channel,
    fringeOrientation: config.orientation,
    roi: config.roi,
    saturationThreshold: 250,
  });
  const raw = Array.from(extracted.profile);
  let corrected = config.background?.length === raw.length
    ? Array.from(subtractBackground(raw, config.background, true))
    : [...raw];
  const baseline = quantile(corrected.filter((_, index) => extracted.samplesPerBin[index] > 0), 0.03);
  corrected = Array.from(subtractBackground(corrected, baseline, true));
  const smooth = Array.from(gaussianSmooth(corrected, config.smoothingSigma));
  // Colour excess preserves the laser's bright-fringe polarity when another
  // channel is anti-correlated. It is a position locator, not radiometry.
  const locator = config.channel === "auto" && extracted.laserColor
    ? Array.from(extracted.profiles[extracted.laserColor], (value, index) => {
        const others = (["r", "g", "b"] as const).filter((color) => color !== extracted.laserColor);
        return Math.max(0, value - (extracted.profiles[others[0]][index] + extracted.profiles[others[1]][index]) / 2);
      })
    : corrected;
  const locationSmooth = Array.from(gaussianSmooth(locator, config.smoothingSigma));
  const p05 = quantile(smooth, 0.05);
  const p95 = quantile(smooth, 0.95);
  const dynamicRange = Math.max(0, p95 - p05);
  const periodEstimate = estimatePeriodAutocorrelation(locationSmooth, {
    minLag: 8,
    maxLag: Math.max(12, Math.floor(smooth.length / 3)),
    minCorrelation: 0.1,
  });
  const periodPx = periodEstimate.period;
  const minDistance = periodPx == null ? 10 : Math.max(7, periodPx * 0.56);
  const prominence = Math.max(1.5, (quantile(locationSmooth, .95) - quantile(locationSmooth, .05)) * 0.07);
  const peakCandidates = detectPeaks(locationSmooth, {
    minProminence: prominence,
    minDistance,
    maxPeaks: 17,
    saturationThreshold: 248,
    plateauTolerance: 0.0001,
  });
  const troughCandidates = detectTroughs(locationSmooth, {
    minProminence: config.experiment === "single"
      ? Math.max(0.1, dynamicRange * 0.015)
      : Math.max(1, prominence * 0.6),
    minDistance: Math.max(6, minDistance * 0.58),
    maxPeaks: 18,
    plateauTolerance: 0.0001,
  });
  const axisPx = Array.from(extracted.axisPositionsPx);
  const angle = (config.roi.angleDeg + (config.orientation === "horizontal" ? 90 : 0)) * Math.PI / 180;
  const hasLocalScale = (config.spatialAnchors?.length ?? 0) >= 3;
  const centerMm = hasLocalScale ? mapScreenPointMm({ x: config.roi.centerX, y: config.roi.centerY }, config.spatialAnchors!) : null;
  const positionMm = (pixel: number) => {
    const mapped = hasLocalScale ? mapScreenPointMm({ x: config.roi.centerX + Math.cos(angle) * pixel, y: config.roi.centerY + Math.sin(angle) * pixel }, config.spatialAnchors!) : null;
    return mapped == null || centerMm == null ? pixel * config.mmPerPixel : mapped - centerMm;
  };
  const locatedPeaks = peakCandidates.map((peak, index) => {
    if (config.channel !== "auto" || !extracted.laserColor || extracted.selectedChannel !== extracted.laserColor || extracted.saturationRates[extracted.selectedChannel] <= .005) return peak;
    // A clipped crown is not a subpixel quadratic maximum. Locate the coloured
    // blob's centroid between neighbouring midpoints, with a local background.
    const left = Math.max(0, Math.ceil(index ? (peakCandidates[index - 1].position + peak.position) / 2 : peak.position - (periodPx ?? minDistance) / 2));
    const right = Math.min(locator.length - 1, Math.floor(index + 1 < peakCandidates.length ? (peak.position + peakCandidates[index + 1].position) / 2 : peak.position + (periodPx ?? minDistance) / 2));
    const base = (locator[left] + locator[right]) / 2;
    let weight = 0; let moment = 0;
    for (let i = left; i <= right; i++) { const w = Math.max(0, locator[i] - base); weight += w; moment += i * w; }
    const position = weight ? moment / weight : peak.position;
    return { ...peak, position, index: Math.round(position) };
  });
  let peaks = locatedPeaks.map((peak) => markAtPosition(peak, axisPx, config.mmPerPixel));
  let troughs = troughCandidates.map((trough) => markAtPosition(trough, axisPx, config.mmPerPixel));
  peaks = peaks.map((peak) => {
    const left = Math.max(0, Math.floor(peak.left ?? peak.position - minDistance * .2));
    const right = Math.min(raw.length - 1, Math.ceil(peak.right ?? peak.position + minDistance * .2));
    const saturated = Array.from(extracted.saturationProfiles[extracted.selectedChannel].slice(left, right + 1)).some((fraction) => fraction > .01);
    const halfWindow = Math.max(3, Math.round((periodPx ?? minDistance) / 2));
    const leftMinimum = Math.min(...smooth.slice(Math.max(0, peak.index - halfWindow), peak.index + 1));
    const rightMinimum = Math.min(...smooth.slice(peak.index, Math.min(smooth.length, peak.index + halfWindow + 1)));
    const fwhm = calculateFwhm(smooth, peak.index, Math.max(leftMinimum, rightMinimum));
    return { ...peak, value: smooth[peak.index], positionMm: positionMm(peak.axisPx), saturated, width: saturated || fwhm?.truncatedLeft || fwhm?.truncatedRight ? null : fwhm?.width ?? null };
  });
  troughs = troughs.map((trough) => ({ ...trough, value: smooth[trough.index], positionMm: positionMm(trough.axisPx) }));
  const centralPeak = peaks.reduce<Mark | null>((best, current) => {
    if (best == null) return current;
    const score = current.value + current.prominence * 0.35 - Math.abs(current.axisPx) * 0.003;
    const bestScore = best.value + best.prominence * 0.35 - Math.abs(best.axisPx) * 0.003;
    return score > bestScore ? current : best;
  }, null);
  const centralPositionMm = centralPeak?.positionMm ?? 0;

  let fringeSpacingMm: number | null = null;
  let centralWidthMm: number | null = null;
  let fwhmMm: number | null = null;
  let wavelengthNm: number | null = null;
  let smallAngleNm: number | null = null;
  let uncertaintyNm: number | null = null;
  let regressionR2: number | null = null;
  let status = "等待可用条纹";

  if (centralPeak?.width != null) {
    fwhmMm = Math.abs(positionMm(centralPeak.axisPx + centralPeak.width / 2) - positionMm(centralPeak.axisPx - centralPeak.width / 2));
  }

  if (config.experiment === "double" && peaks.length >= 2) {
    const spacings = peaks
      .slice(1)
      .map((peak, index) => peak.positionMm - peaks[index].positionMm)
      .filter((spacing) => spacing > config.mmPerPixel * 3);
    fringeSpacingMm = median(spacings) ?? (periodPx == null ? null : periodPx * config.mmPerPixel);
    if (fringeSpacingMm != null && centralPeak != null) {
      peaks = peaks.map((peak) => ({
        ...peak,
        order: Math.round((peak.positionMm - centralPositionMm) / fringeSpacingMm!),
      }));
      const byOrder = new Map<number, Mark>();
      for (const peak of peaks) {
        if (peak.order == null) continue;
        const previous = byOrder.get(peak.order);
        if (previous == null || peak.prominence > previous.prominence) byOrder.set(peak.order, peak);
      }
      const observations = [...byOrder.values()]
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .map((peak) => ({
          order: peak.order ?? 0,
          screenPositionM: peak.positionMm / 1000,
        }));
      if (observations.length >= 3) {
        try {
          const regression = fitDoubleSlitOrders({
            observations,
            screenDistanceM: config.screenDistanceM,
            slitSeparationM: config.slitSeparationMm / 1000,
            centerPositionM: centralPositionMm / 1000,
          });
          wavelengthNm = regression.wavelengthM * 1e9;
          regressionR2 = regression.rSquared;
          status = `多级亮纹精确回归（${observations.length} 点）`;
          // Compare exact and paraxial geometry on the SAME observations.
          const paraxial = weightedLinearRegression(observations.map((point) => ({ order: point.order, sinTheta: (point.screenPositionM - centralPositionMm / 1000) / config.screenDistanceM })));
          smallAngleNm = Math.abs(paraxial.slope) * config.slitSeparationMm * 1e6;
          fringeSpacingMm = Math.abs(paraxial.slope) * config.screenDistanceM * 1000;
        } catch {
          // The small-angle fallback below remains available for sparse/noisy data.
        }
      }
      smallAngleNm ??=
        (config.slitSeparationMm * fringeSpacingMm * 1e-6) /
        config.screenDistanceM * 1e9;
      if (wavelengthNm == null) {
        wavelengthNm = smallAngleNm;
        status = "相邻亮纹间距（小角近似）";
      }
      const spacingScatter = standardDeviation(spacings) / Math.sqrt(Math.max(1, spacings.length));
      const spacingUncertaintyMm = Math.hypot(
        Math.max(config.mmPerPixel / Math.sqrt(12), spacingScatter),
        fringeSpacingMm * config.calibrationUncertaintyPct / 100,
      );
      try {
        const uncertainty = doubleSlitSmallAngleUncertainty({
          slitSeparationM: {
            value: config.slitSeparationMm / 1000,
            standardUncertainty: config.apertureUncertaintyMm / 1000,
          },
          fringeSpacingM: {
            value: fringeSpacingMm / 1000,
            standardUncertainty: spacingUncertaintyMm / 1000,
          },
          screenDistanceM: {
            value: config.screenDistanceM,
            standardUncertainty: config.distanceUncertaintyM,
          },
        });
        uncertaintyNm = uncertainty.standardUncertaintyM * 1e9 * 1.96;
      } catch {
        uncertaintyNm = null;
      }
    }
  }

  if (config.experiment === "single" && centralPeak != null && troughs.length >= 2) {
    const left = troughs
      .filter((trough) => trough.positionMm < centralPositionMm)
      .sort((a, b) => b.positionMm - a.positionMm);
    const right = troughs
      .filter((trough) => trough.positionMm > centralPositionMm)
      .sort((a, b) => a.positionMm - b.positionMm);
    const firstLeft = left[0];
    const firstRight = right[0];
    if (firstLeft && firstRight) {
      centralWidthMm = firstRight.positionMm - firstLeft.positionMm;
      const firstZeroHalfWidth =
        ((centralPositionMm - firstLeft.positionMm) +
          (firstRight.positionMm - centralPositionMm)) /
        2;
      troughs = troughs.map((trough) => {
        const relative = trough.positionMm - centralPositionMm;
        return {
          ...trough,
          order: Math.sign(relative) * Math.max(1, Math.round(Math.abs(relative) / firstZeroHalfWidth)),
        };
      });
      const observations = troughs.map((trough) => ({
        order: trough.order ?? 1,
        screenPositionM: trough.positionMm / 1000,
      }));
      if (observations.length >= 2) {
        try {
          const regression = fitSingleSlitDarkFringes({
            observations,
            screenDistanceM: config.screenDistanceM,
            slitWidthM: config.slitWidthMm / 1000,
            centerPositionM: centralPositionMm / 1000,
          });
          wavelengthNm = regression.wavelengthM * 1e9;
          regressionR2 = regression.rSquared;
          status = `多级暗纹精确回归（${observations.length} 点）`;
          const paraxial = weightedLinearRegression(observations.map((point) => ({ order: point.order, sinTheta: (point.screenPositionM - centralPositionMm / 1000) / config.screenDistanceM })));
          smallAngleNm = Math.abs(paraxial.slope) * config.slitWidthMm * 1e6;
        } catch {
          // The first-zero result below remains available.
        }
      }
      smallAngleNm ??=
        (config.slitWidthMm * centralWidthMm * 1e-6) /
        (2 * config.screenDistanceM) * 1e9;
      if (wavelengthNm == null) {
        wavelengthNm = smallAngleNm;
        status = "第一暗纹中央宽度（小角近似）";
      }
      const widthUncertaintyMm = Math.hypot(
        config.mmPerPixel * Math.sqrt(2 / 12),
        centralWidthMm * config.calibrationUncertaintyPct / 100,
      );
      try {
        const uncertainty = singleSlitSmallAngleUncertainty({
          slitWidthM: {
            value: config.slitWidthMm / 1000,
            standardUncertainty: config.apertureUncertaintyMm / 1000,
          },
          centralMaximumWidthM: {
            value: centralWidthMm / 1000,
            standardUncertainty: widthUncertaintyMm / 1000,
          },
          screenDistanceM: {
            value: config.screenDistanceM,
            standardUncertainty: config.distanceUncertaintyM,
          },
        });
        uncertaintyNm = uncertainty.standardUncertaintyM * 1e9 * 1.96;
      } catch {
        uncertaintyNm = null;
      }
    }
  }

  let fresnelNumber: number | null = null;
  const modelWavelengthNm = wavelengthNm ?? config.referenceWavelengthNm;
  try {
    fresnelNumber = config.slitWidthKnown === false ? null : config.experiment === "double"
      ? doubleSlitFresnelNumber({
          slitWidthM: config.slitWidthMm / 1000,
          slitSeparationM: config.slitSeparationMm / 1000,
          wavelengthM: modelWavelengthNm * 1e-9,
          screenDistanceM: config.screenDistanceM,
        })
      : singleSlitFresnelNumber({
          slitWidthM: config.slitWidthMm / 1000,
          wavelengthM: modelWavelengthNm * 1e-9,
          screenDistanceM: config.screenDistanceM,
        });
  } catch {
    fresnelNumber = null;
  }

  const idealModel = axisPx.map((positionPx) => {
    const screenPositionM = positionMm(positionPx) / 1000;
    const centerPositionM = centralPositionMm / 1000;
    try {
      return config.experiment === "double"
        ? finiteDoubleSlitIntensity({
            screenPositionM,
            centerPositionM,
            screenDistanceM: config.screenDistanceM,
            wavelengthM: modelWavelengthNm * 1e-9,
            slitWidthM: config.slitWidthMm / 1000,
            slitSeparationM: config.slitSeparationMm / 1000,
          })
        : singleSlitIntensity({
            screenPositionM,
            centerPositionM,
            screenDistanceM: config.screenDistanceM,
            wavelengthM: modelWavelengthNm * 1e-9,
            slitWidthM: config.slitWidthMm / 1000,
          });
    } catch {
      return 0;
    }
  });

  const saturationRate = extracted.saturationRates[extracted.selectedChannel];
  const anchors = config.spatialAnchors ?? [];
  const minimumMm = anchors.length ? Math.min(...anchors.map((anchor) => anchor.mm)) : -Infinity;
  const maximumMm = anchors.length ? Math.max(...anchors.map((anchor) => anchor.mm)) : Infinity;
  const extrapolated = centerMm != null && peaks.some((peak) => peak.positionMm + centerMm < minimumMm || peak.positionMm + centerMm > maximumMm);
  const provisional = peaks.some((peak) => peak.saturated) || saturationRate > .002 || extrapolated;
  const measurementReady = config.measurementReady !== false;
  const warnings: string[] = [];
  if (peaks.some((peak) => peak.saturated) || saturationRate > .002) warnings.push("原始像素过曝：峰高与宽度不可信，波长仅为峰位暂估；请降低曝光后复测。");
  if (extrapolated) warnings.push("部分亮峰超出局部尺标范围，位置为外推暂估；请补充覆盖这些亮峰的尺标点。");
  if (!measurementReady) warnings.push("请确认实测 d / L 并完成当前图像尺标，暂不输出物理测量值。");
  if (config.slitWidthKnown === false) warnings.push("缝宽 a 未知：不计算远场质量指标，也不宣称衍射包络拟合有效。");
  return {
    raw,
    corrected,
    smooth,
    model: normalizeChartSeries(idealModel),
    axisPx,
    axisMm: axisPx.map(positionMm),
    peaks,
    troughs,
    selectedChannel: extracted.selectedChannel,
    channelReason: extracted.channelReason,
    saturationByChannel: { ...extracted.saturationRates },
    saturationRate,
    provisional,
    measurementReady,
    warnings,
    dynamicRange,
    periodPx,
    fringeSpacingMm: measurementReady ? fringeSpacingMm : null,
    centralWidthMm: measurementReady ? centralWidthMm : null,
    fwhmMm: measurementReady ? fwhmMm : null,
    wavelengthNm: measurementReady ? wavelengthNm : null,
    smallAngleNm: measurementReady ? smallAngleNm : null,
    uncertaintyNm: measurementReady && !provisional ? uncertaintyNm : null,
    referenceErrorPct:
      wavelengthNm == null || !measurementReady || config.hasReference === false
        ? null
        : Math.abs(wavelengthNm - config.referenceWavelengthNm) /
          config.referenceWavelengthNm * 100,
    smallAngleDifferencePct:
      wavelengthNm == null || smallAngleNm == null || !measurementReady
        ? null
        : Math.abs(wavelengthNm - smallAngleNm) / wavelengthNm * 100,
    regressionR2,
    fresnelNumber,
    centralPositionMm,
    status: !measurementReady ? "待确认参数与尺标" : provisional ? `暂估（质量降级）· ${status}` : status,
  };
}
