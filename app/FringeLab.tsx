"use client";

import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  closeCamera,
  enumerateVideoInputs,
  lockCurrentCameraSettings,
  openCamera,
  type CameraSnapshot,
} from "@/lib/camera";
import { downloadBlob, downloadText, rowsToCsv, timestampSlug } from "@/lib/export";
import {
  doubleSlitFresnelNumber,
  doubleSlitSmallAngleUncertainty,
  finiteDoubleSlitIntensity,
  fitDoubleSlitOrders,
  fitSingleSlitDarkFringes,
  singleSlitFresnelNumber,
  singleSlitIntensity,
  singleSlitSmallAngleUncertainty,
} from "@/lib/physics";
import {
  detectPeaks,
  detectTroughs,
  estimatePeriodAutocorrelation,
  extractStripProfile,
  gaussianSmooth,
  subtractBackground,
  type DetectedExtremum,
  type FringeOrientation,
  type ImageDataLike,
  type RequestedProfileChannel,
} from "@/lib/signal";
import { simulateDiffraction } from "@/lib/simulator";
import { CHART_DISPLAY_CEILING, normalizeChartSeries } from "@/lib/chart";
import {
  hitTestRoiCorner,
  isPointInsideRoi,
  resizeRoiFromCorner,
  roiCornerCursor,
  roiCornerPoint,
  ROI_CORNERS,
  type Point,
  type RoiCorner,
  type RoiGeometry,
} from "@/lib/roi";

type SourceMode = "simulator" | "camera" | "image";
type ExperimentMode = "double" | "single";
type Level = "good" | "warn" | "danger";

type Roi = RoiGeometry;

type RoiInteraction =
  | { mode: "move"; startPoint: Point; startRoi: Roi }
  | { mode: "resize"; corner: RoiCorner; startRoi: Roi };

type Mark = DetectedExtremum & {
  axisPx: number;
  positionMm: number;
  order: number | null;
};

type Analysis = {
  raw: number[];
  corrected: number[];
  smooth: number[];
  model: number[];
  axisPx: number[];
  axisMm: number[];
  peaks: Mark[];
  troughs: Mark[];
  selectedChannel: string;
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

type AnalysisConfig = {
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
};

const FRAME_WIDTH = 960;
const FRAME_HEIGHT = 540;
const ROI_MIN_WIDTH = 80;
const ROI_MIN_HEIGHT = 24;
const ROI_MAX_WIDTH = 930;
const ROI_MAX_HEIGHT = 420;
const ROI_HANDLE_HIT_RADIUS = 18;
const DEFAULT_ROI: Roi = {
  centerX: FRAME_WIDTH / 2,
  centerY: FRAME_HEIGHT / 2,
  width: 820,
  height: 116,
  angleDeg: 0,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

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

function formatNumber(value: number | null, digits = 2, fallback = "—"): string {
  return value == null || !Number.isFinite(value) ? fallback : value.toFixed(digits);
}

function levelFor(value: number, goodBelow: number, warnBelow: number): Level {
  if (value < goodBelow) return "good";
  if (value < warnBelow) return "warn";
  return "danger";
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

function analyseFrame(image: ImageDataLike, config: AnalysisConfig): Analysis {
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
  const baseline = quantile(corrected, 0.03);
  corrected = Array.from(subtractBackground(corrected, baseline, true));
  const smooth = Array.from(gaussianSmooth(corrected, config.smoothingSigma));
  const p05 = quantile(smooth, 0.05);
  const p95 = quantile(smooth, 0.95);
  const dynamicRange = Math.max(0, p95 - p05);
  const periodEstimate = estimatePeriodAutocorrelation(smooth, {
    minLag: 8,
    maxLag: Math.max(12, Math.floor(smooth.length / 3)),
    minCorrelation: 0.1,
  });
  const periodPx = periodEstimate.period;
  const minDistance = periodPx == null ? 10 : Math.max(7, periodPx * 0.56);
  const prominence = Math.max(1.5, dynamicRange * 0.07);
  const peakCandidates = detectPeaks(smooth, {
    minProminence: prominence,
    minDistance,
    maxPeaks: 17,
    saturationThreshold: 248,
    plateauTolerance: 0.0001,
  });
  const troughCandidates = detectTroughs(smooth, {
    minProminence: config.experiment === "single"
      ? Math.max(0.1, dynamicRange * 0.015)
      : Math.max(1, prominence * 0.6),
    minDistance: Math.max(6, minDistance * 0.58),
    maxPeaks: 18,
    plateauTolerance: 0.0001,
  });
  const axisPx = Array.from(extracted.axisPositionsPx);
  let peaks = peakCandidates.map((peak) => markAtPosition(peak, axisPx, config.mmPerPixel));
  let troughs = troughCandidates.map((trough) => markAtPosition(trough, axisPx, config.mmPerPixel));
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
    fwhmMm = centralPeak.width * config.mmPerPixel;
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
        if (peak.order == null || peak.saturated) continue;
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
        } catch {
          // The small-angle fallback below remains available for sparse/noisy data.
        }
      }
      smallAngleNm =
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
        } catch {
          // The first-zero result below remains available.
        }
      }
      smallAngleNm =
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
    fresnelNumber = config.experiment === "double"
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
    const screenPositionM = positionPx * config.mmPerPixel / 1000;
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

  return {
    raw,
    corrected,
    smooth,
    model: normalizeChartSeries(idealModel),
    axisPx,
    axisMm: axisPx.map((value) => value * config.mmPerPixel),
    peaks,
    troughs,
    selectedChannel: extracted.selectedChannel,
    saturationRate: extracted.saturationRates[extracted.selectedChannel],
    dynamicRange,
    periodPx,
    fringeSpacingMm,
    centralWidthMm,
    fwhmMm,
    wavelengthNm,
    smallAngleNm,
    uncertaintyNm,
    referenceErrorPct:
      wavelengthNm == null
        ? null
        : Math.abs(wavelengthNm - config.referenceWavelengthNm) /
          config.referenceWavelengthNm * 100,
    smallAngleDifferencePct:
      wavelengthNm == null || smallAngleNm == null
        ? null
        : Math.abs(wavelengthNm - smallAngleNm) / wavelengthNm * 100,
    regressionR2,
    fresnelNumber,
    centralPositionMm,
    status,
  };
}

function drawContained(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): void {
  context.fillStyle = "#02050a";
  context.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  const scale = Math.min(FRAME_WIDTH / sourceWidth, FRAME_HEIGHT / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  context.drawImage(source, (FRAME_WIDTH - width) / 2, (FRAME_HEIGHT - height) / 2, width, height);
}

function FieldNumber({
  label,
  value,
  unit,
  min,
  max,
  step,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  const inputId = useId();
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <div className={`input-shell ${unit ? "has-unit" : ""}`}>
        <input
          id={inputId}
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(finiteOr(event.currentTarget.valueAsNumber, value))}
        />
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

function QualityItem({ label, value, level }: { label: string; value: string; level: Level }) {
  return (
    <div className="quality-item">
      <span className={`quality-dot ${level}`} />
      <span>{label}</span>
      <span className="quality-value">{value}</span>
    </div>
  );
}

export default function FringeLab() {
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const chartCanvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const roiInteractionRef = useRef<RoiInteraction | null>(null);

  const [sourceMode, setSourceMode] = useState<SourceMode>("simulator");
  const [experiment, setExperiment] = useState<ExperimentMode>("double");
  const [channel, setChannel] = useState<RequestedProfileChannel>("auto");
  const [orientation, setOrientation] = useState<FringeOrientation>("vertical");
  const [roi, setRoi] = useState<Roi>(DEFAULT_ROI);
  const [mmPerPixel, setMmPerPixel] = useState(0.02);
  const [screenDistanceM, setScreenDistanceM] = useState(1.5);
  const [slitWidthMm, setSlitWidthMm] = useState(0.04);
  const [slitSeparationMm, setSlitSeparationMm] = useState(0.25);
  const [referenceWavelengthNm, setReferenceWavelengthNm] = useState(650);
  const [apertureUncertaintyMm, setApertureUncertaintyMm] = useState(0.002);
  const [distanceUncertaintyM, setDistanceUncertaintyM] = useState(0.005);
  const [calibrationUncertaintyPct, setCalibrationUncertaintyPct] = useState(1);
  const [smoothingSigma, setSmoothingSigma] = useState(1.8);
  const [simNoise, setSimNoise] = useState(0.012);
  const [simGamma, setSimGamma] = useState(1);
  const [simSaturation, setSimSaturation] = useState(0.96);
  const [simSeed, setSimSeed] = useState(2026);
  const [background, setBackground] = useState<number[] | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [cameraSnapshot, setCameraSnapshot] = useState<CameraSnapshot | null>(null);
  const [cameraLocked, setCameraLocked] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isFrozen, setIsFrozen] = useState(false);
  const [calibrationMode, setCalibrationMode] = useState(false);
  const [calibrationLengthMm, setCalibrationLengthMm] = useState(10);
  const [calibrationPoints, setCalibrationPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [showModelFit, setShowModelFit] = useState(true);
  const [toast, setToast] = useState("");

  const config = useMemo<AnalysisConfig>(() => ({
    experiment,
    channel,
    orientation,
    roi,
    mmPerPixel,
    screenDistanceM,
    slitWidthMm,
    slitSeparationMm,
    apertureUncertaintyMm,
    distanceUncertaintyM,
    calibrationUncertaintyPct,
    referenceWavelengthNm,
    smoothingSigma,
    background,
  }), [
    experiment,
    channel,
    orientation,
    roi,
    mmPerPixel,
    screenDistanceM,
    slitWidthMm,
    slitSeparationMm,
    apertureUncertaintyMm,
    distanceUncertaintyM,
    calibrationUncertaintyPct,
    referenceWavelengthNm,
    smoothingSigma,
    background,
  ]);

  const processCurrentCanvas = useCallback(() => {
    const canvas = frameCanvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    try {
      const imageData = context.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
      setAnalysis(analyseFrame(imageData, config));
      setAnalysisError(null);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "帧分析失败");
    }
  }, [config]);

  const renderSimulator = useCallback(() => {
    const canvas = frameCanvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    canvas.width = FRAME_WIDTH;
    canvas.height = FRAME_HEIGHT;
    const result = simulateDiffraction({
      kind: experiment === "double" ? "double-slit" : "single-slit",
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      wavelengthNm: referenceWavelengthNm,
      slitWidthMm,
      slitSeparationMm,
      screenDistanceM,
      mmPerPixel,
      noiseStd: simNoise,
      gamma: simGamma,
      saturationLevel: simSaturation,
      rotationDeg: roi.angleDeg,
      seed: simSeed,
      background: 0.012,
    });
    const simulatedFrame = context.createImageData(result.frame.width, result.frame.height);
    simulatedFrame.data.set(result.frame.data);
    context.putImageData(simulatedFrame, 0, 0);
    processCurrentCanvas();
  }, [
    experiment,
    referenceWavelengthNm,
    slitWidthMm,
    slitSeparationMm,
    screenDistanceM,
    mmPerPixel,
    simNoise,
    simGamma,
    simSaturation,
    roi.angleDeg,
    simSeed,
    processCurrentCanvas,
  ]);

  useEffect(() => {
    const canvas = frameCanvasRef.current;
    if (canvas) {
      canvas.width = FRAME_WIDTH;
      canvas.height = FRAME_HEIGHT;
    }
    const overlay = overlayCanvasRef.current;
    if (overlay) {
      overlay.width = FRAME_WIDTH;
      overlay.height = FRAME_HEIGHT;
    }
    enumerateVideoInputs().then(setDevices).catch(() => undefined);
    return () => {
      closeCamera(streamRef.current);
      if (animationRef.current != null) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  useEffect(() => {
    if (sourceMode !== "simulator") return;
    renderSimulator();
  }, [sourceMode, renderSimulator]);

  useEffect(() => {
    if (sourceMode !== "camera" || isFrozen) return;
    const loop = (timestamp: number) => {
      const canvas = frameCanvasRef.current;
      const video = videoRef.current;
      const context = canvas?.getContext("2d", { willReadFrequently: true });
      if (canvas && video && context && video.readyState >= 2) {
        drawContained(context, video, video.videoWidth || 1280, video.videoHeight || 720);
        if (timestamp - lastFrameRef.current > 110) {
          lastFrameRef.current = timestamp;
          processCurrentCanvas();
        }
      }
      animationRef.current = requestAnimationFrame(loop);
    };
    animationRef.current = requestAnimationFrame(loop);
    return () => {
      if (animationRef.current != null) cancelAnimationFrame(animationRef.current);
    };
  }, [sourceMode, isFrozen, processCurrentCanvas]);

  useEffect(() => {
    if (sourceMode !== "image" || !imageRef.current) return;
    const canvas = frameCanvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    drawContained(
      context,
      imageRef.current,
      imageRef.current.naturalWidth,
      imageRef.current.naturalHeight,
    );
    processCurrentCanvas();
  }, [sourceMode, processCurrentCanvas]);

  useEffect(() => {
    const overlay = overlayCanvasRef.current;
    const context = overlay?.getContext("2d");
    if (!overlay || !context) return;
    context.clearRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
    context.save();
    context.translate(roi.centerX, roi.centerY);
    context.rotate(roi.angleDeg * Math.PI / 180);
    context.fillStyle = "rgba(99, 230, 209, 0.075)";
    context.strokeStyle = "rgba(99, 230, 209, 0.95)";
    context.lineWidth = 1.5;
    context.setLineDash([8, 6]);
    context.fillRect(-roi.width / 2, -roi.height / 2, roi.width, roi.height);
    context.strokeRect(-roi.width / 2, -roi.height / 2, roi.width, roi.height);
    context.setLineDash([]);
    context.strokeStyle = "rgba(255,255,255,.75)";
    context.beginPath();
    context.moveTo(-10, 0);
    context.lineTo(10, 0);
    context.moveTo(0, -10);
    context.lineTo(0, 10);
    context.stroke();
    context.restore();

    for (const corner of ROI_CORNERS) {
      const point = roiCornerPoint(roi, corner);
      context.fillStyle = "rgba(3, 12, 18, .9)";
      context.fillRect(point.x - 6, point.y - 6, 12, 12);
      context.fillStyle = "#63e6d1";
      context.fillRect(point.x - 4, point.y - 4, 8, 8);
    }

    if (calibrationPoints.length > 0) {
      context.save();
      context.strokeStyle = "#ffc766";
      context.fillStyle = "#ffc766";
      context.lineWidth = 2;
      context.setLineDash([5, 4]);
      if (calibrationPoints.length === 2) {
        context.beginPath();
        context.moveTo(calibrationPoints[0].x, calibrationPoints[0].y);
        context.lineTo(calibrationPoints[1].x, calibrationPoints[1].y);
        context.stroke();
      }
      calibrationPoints.forEach((point, index) => {
        context.beginPath();
        context.arc(point.x, point.y, 6, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = "#071019";
        context.font = "bold 9px monospace";
        context.fillText(String(index + 1), point.x - 3, point.y + 3);
        context.fillStyle = "#ffc766";
      });
      context.restore();
    }
  }, [roi, calibrationPoints]);

  useEffect(() => {
    const canvas = chartCanvasRef.current;
    if (!canvas || !analysis) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(dpr, dpr);
    const width = rect.width;
    const height = rect.height;
    const margins = { left: 42, right: 13, top: 13, bottom: 27 };
    const plotWidth = Math.max(1, width - margins.left - margins.right);
    const plotHeight = Math.max(1, height - margins.top - margins.bottom);
    context.clearRect(0, 0, width, height);
    context.font = "9px monospace";
    context.fillStyle = "#607489";
    context.strokeStyle = "rgba(151,184,214,.10)";
    context.lineWidth = 1;
    for (let index = 0; index <= 4; index += 1) {
      const y = margins.top + plotHeight * index / 4;
      context.beginPath();
      context.moveTo(margins.left, y);
      context.lineTo(width - margins.right, y);
      context.stroke();
      context.fillText(`${Math.round(100 - index * 25)}%`, 7, y + 3);
    }
    for (let index = 0; index <= 6; index += 1) {
      const x = margins.left + plotWidth * index / 6;
      context.beginPath();
      context.moveTo(x, margins.top);
      context.lineTo(x, margins.top + plotHeight);
      context.stroke();
      const axisIndex = Math.round((analysis.axisMm.length - 1) * index / 6);
      context.fillText(formatNumber(analysis.axisMm[axisIndex] ?? 0, 1), x - 10, height - 7);
    }
    const toX = (index: number) => margins.left + index / Math.max(1, analysis.raw.length - 1) * plotWidth;
    const toY = (value: number) =>
      margins.top + (1 - clamp(value, 0, CHART_DISPLAY_CEILING)) * plotHeight;
    const rawNormal = normalizeChartSeries(analysis.raw);
    const smoothNormal = normalizeChartSeries(analysis.smooth);
    const drawLine = (values: readonly number[], color: string, lineWidth: number, dash: number[] = []) => {
      context.beginPath();
      values.forEach((value, index) => {
        const x = toX(index);
        const y = toY(value);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.strokeStyle = color;
      context.lineWidth = lineWidth;
      context.setLineDash(dash);
      context.stroke();
      context.setLineDash([]);
    };
    drawLine(rawNormal, "rgba(137,161,183,.35)", 1);
    if (showModelFit) {
      drawLine(analysis.model, "rgba(255,199,102,.82)", 1.2, [5, 4]);
    }
    drawLine(smoothNormal, "#63e6d1", 1.8);
    for (const mark of analysis.peaks) {
      const x = toX(mark.position);
      const y = toY(smoothNormal[Math.round(clamp(mark.position, 0, smoothNormal.length - 1))]);
      context.fillStyle = mark.saturated ? "#ff6b6f" : "#f4f8fb";
      context.beginPath();
      context.arc(x, y, 2.8, 0, Math.PI * 2);
      context.fill();
    }
    for (const mark of analysis.troughs) {
      const x = toX(mark.position);
      const y = toY(smoothNormal[Math.round(clamp(mark.position, 0, smoothNormal.length - 1))]);
      context.strokeStyle = "#62a8ff";
      context.lineWidth = 1.3;
      context.strokeRect(x - 2.2, y - 2.2, 4.4, 4.4);
    }
  }, [analysis, showModelFit]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const startCamera = async () => {
    setCameraError(null);
    setCameraLocked(false);
    try {
      closeCamera(streamRef.current);
      const result = await openCamera(selectedDeviceId || undefined);
      streamRef.current = result.stream;
      setCameraSnapshot(result.snapshot);
      setSourceMode("camera");
      setIsFrozen(false);
      if (videoRef.current) {
        videoRef.current.srcObject = result.stream;
        await videoRef.current.play();
      }
      setDevices(await enumerateVideoInputs());
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : "无法打开摄像头");
    }
  };

  const stopCamera = () => {
    closeCamera(streamRef.current);
    streamRef.current = null;
    setCameraSnapshot(null);
    setCameraLocked(false);
    setIsFrozen(false);
    setSourceMode("simulator");
  };

  const lockCamera = async () => {
    if (!streamRef.current) return;
    try {
      const snapshot = await lockCurrentCameraSettings(streamRef.current);
      setCameraSnapshot(snapshot);
      const settings = snapshot.settings;
      setCameraLocked(
        settings.exposureMode === "manual" ||
          settings.focusMode === "manual" ||
          settings.whiteBalanceMode === "manual",
      );
      setToast("已尝试锁定浏览器允许的曝光、对焦和白平衡");
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : "浏览器不允许锁定设置");
    }
  };

  const handleImageUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      closeCamera(streamRef.current);
      streamRef.current = null;
      setCameraSnapshot(null);
      setCameraLocked(false);
      imageRef.current = image;
      setSourceMode("image");
      setIsFrozen(true);
      setToast(`已载入 ${file.name}`);
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setAnalysisError("图片解码失败，请换用 PNG/JPEG/WebP");
    };
    image.src = url;
  };

  const freezeCurrentFrame = () => {
    const canvas = frameCanvasRef.current;
    if (!canvas) return;
    const image = new Image();
    image.onload = () => {
      closeCamera(streamRef.current);
      streamRef.current = null;
      setCameraSnapshot(null);
      setCameraLocked(false);
      imageRef.current = image;
      setSourceMode("image");
      setIsFrozen(true);
      setToast("已冻结当前帧");
    };
    image.src = canvas.toDataURL("image/png");
  };

  const pointerPosition = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rectangle = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rectangle.left) / rectangle.width * FRAME_WIDTH,
      y: (event.clientY - rectangle.top) / rectangle.height * FRAME_HEIGHT,
    };
  };

  const updateOverlayCursor = (canvas: HTMLCanvasElement, point: Point) => {
    const corner = hitTestRoiCorner(roi, point, ROI_HANDLE_HIT_RADIUS);
    canvas.style.cursor = corner
      ? roiCornerCursor(corner)
      : isPointInsideRoi(roi, point) ? "move" : "crosshair";
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerPosition(event);
    if (calibrationMode) {
      const next = calibrationPoints.length >= 2 ? [point] : [...calibrationPoints, point];
      setCalibrationPoints(next);
      if (next.length === 2) {
        const pixelDistance = Math.hypot(next[1].x - next[0].x, next[1].y - next[0].y);
        if (pixelDistance > 1) {
          setMmPerPixel(calibrationLengthMm / pixelDistance);
          setCalibrationMode(false);
          setToast(`标定完成：${(calibrationLengthMm / pixelDistance).toFixed(5)} mm/px`);
        }
      }
      return;
    }
    const corner = hitTestRoiCorner(roi, point, ROI_HANDLE_HIT_RADIUS);
    if (corner) {
      roiInteractionRef.current = { mode: "resize", corner, startRoi: roi };
      event.currentTarget.style.cursor = roiCornerCursor(corner);
      return;
    }
    if (isPointInsideRoi(roi, point)) {
      roiInteractionRef.current = { mode: "move", startPoint: point, startRoi: roi };
      event.currentTarget.style.cursor = "grabbing";
    }
  };

  const handleOverlayKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const delta = event.shiftKey ? 10 : 2;
    const movement: Record<string, readonly [number, number]> = {
      ArrowLeft: [-delta, 0],
      ArrowRight: [delta, 0],
      ArrowUp: [0, -delta],
      ArrowDown: [0, delta],
    };
    const offset = movement[event.key];
    if (!offset) return;
    event.preventDefault();
    setRoi((previous) => ({
      ...previous,
      centerX: clamp(previous.centerX + offset[0], 0, FRAME_WIDTH),
      centerY: clamp(previous.centerY + offset[1], 0, FRAME_HEIGHT),
    }));
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (calibrationMode) return;
    const point = pointerPosition(event);
    const interaction = roiInteractionRef.current;
    if (!interaction) {
      updateOverlayCursor(event.currentTarget, point);
      return;
    }
    if (interaction.mode === "move") {
      setRoi({
        ...interaction.startRoi,
        centerX: clamp(
          interaction.startRoi.centerX + point.x - interaction.startPoint.x,
          0,
          FRAME_WIDTH,
        ),
        centerY: clamp(
          interaction.startRoi.centerY + point.y - interaction.startPoint.y,
          0,
          FRAME_HEIGHT,
        ),
      });
      return;
    }
    setRoi(resizeRoiFromCorner(
      interaction.startRoi,
      interaction.corner,
      {
        x: clamp(point.x, 0, FRAME_WIDTH),
        y: clamp(point.y, 0, FRAME_HEIGHT),
      },
      {
        minWidth: ROI_MIN_WIDTH,
        minHeight: ROI_MIN_HEIGHT,
        maxWidth: ROI_MAX_WIDTH,
        maxHeight: ROI_MAX_HEIGHT,
      },
    ));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    roiInteractionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    updateOverlayCursor(event.currentTarget, pointerPosition(event));
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    roiInteractionRef.current = null;
    event.currentTarget.style.cursor = calibrationMode ? "crosshair" : "default";
  };

  const exportCsv = () => {
    if (!analysis) return;
    const csv = rowsToCsv(
      ["index", "position_px", "position_mm", "raw_dn", "corrected_au", "smoothed_au", "model_normalized"],
      analysis.raw.map((value, index) => [
        index,
        analysis.axisPx[index],
        analysis.axisMm[index],
        value,
        analysis.corrected[index],
        analysis.smooth[index],
        analysis.model[index],
      ]),
    );
    downloadText(`\uFEFF${csv}`, `fringelab-${timestampSlug()}.csv`, "text/csv;charset=utf-8");
  };

  const exportJson = () => {
    if (!analysis) return;
    downloadText(
      JSON.stringify(
        {
          schema: "fringelab.measurement.v1",
          createdAt: new Date().toISOString(),
          terminology: "Relative intensity (camera response, arbitrary units); not lux.",
          configuration: {
            sourceMode,
            experiment,
            channel,
            orientation,
            roi,
            mmPerPixel,
            screenDistanceM,
            slitWidthMm,
            slitSeparationMm,
            referenceWavelengthNm,
            showModelFit,
          },
          result: analysis,
        },
        null,
        2,
      ),
      `fringelab-${timestampSlug()}.json`,
      "application/json;charset=utf-8",
    );
  };

  const exportPng = () => {
    chartCanvasRef.current?.toBlob((blob) => {
      if (blob) downloadBlob(blob, `fringelab-curve-${timestampSlug()}.png`);
    }, "image/png");
  };

  const saveSession = () => {
    localStorage.setItem("fringelab-session-v1", JSON.stringify({
      experiment,
      channel,
      orientation,
      roi,
      mmPerPixel,
      screenDistanceM,
      slitWidthMm,
      slitSeparationMm,
      referenceWavelengthNm,
      apertureUncertaintyMm,
      distanceUncertaintyM,
      calibrationUncertaintyPct,
      smoothingSigma,
      showModelFit,
    }));
    setToast("实验参数已保存在本机浏览器");
  };

  const loadSession = () => {
    try {
      const stored = localStorage.getItem("fringelab-session-v1");
      if (!stored) {
        setToast("本机尚无已保存会话");
        return;
      }
      const value = JSON.parse(stored) as Record<string, unknown>;
      if (value.experiment === "single" || value.experiment === "double") setExperiment(value.experiment);
      if (typeof value.mmPerPixel === "number") setMmPerPixel(value.mmPerPixel);
      if (typeof value.screenDistanceM === "number") setScreenDistanceM(value.screenDistanceM);
      if (typeof value.slitWidthMm === "number") setSlitWidthMm(value.slitWidthMm);
      if (typeof value.slitSeparationMm === "number") setSlitSeparationMm(value.slitSeparationMm);
      if (typeof value.referenceWavelengthNm === "number") setReferenceWavelengthNm(value.referenceWavelengthNm);
      if (typeof value.apertureUncertaintyMm === "number") setApertureUncertaintyMm(value.apertureUncertaintyMm);
      if (typeof value.distanceUncertaintyM === "number") setDistanceUncertaintyM(value.distanceUncertaintyM);
      if (typeof value.calibrationUncertaintyPct === "number") setCalibrationUncertaintyPct(value.calibrationUncertaintyPct);
      if (typeof value.smoothingSigma === "number") setSmoothingSigma(value.smoothingSigma);
      if (typeof value.showModelFit === "boolean") setShowModelFit(value.showModelFit);
      if (value.roi && typeof value.roi === "object") setRoi(value.roi as Roi);
      if (["auto", "r", "g", "b", "luminance"].includes(String(value.channel))) {
        setChannel(value.channel as RequestedProfileChannel);
      }
      if (value.orientation === "vertical" || value.orientation === "horizontal") {
        setOrientation(value.orientation);
      }
      setToast("已恢复本机实验参数");
    } catch {
      setToast("本地会话格式无效");
    }
  };

  const selectPreset = (mode: ExperimentMode, wavelengthNm: number) => {
    closeCamera(streamRef.current);
    streamRef.current = null;
    setCameraSnapshot(null);
    setCameraLocked(false);
    setIsFrozen(false);
    setExperiment(mode);
    setReferenceWavelengthNm(wavelengthNm);
    setChannel("auto");
    setMmPerPixel(0.02);
    setScreenDistanceM(1.5);
    setSlitWidthMm(mode === "double" ? 0.04 : 0.12);
    setSlitSeparationMm(0.25);
    setRoi(DEFAULT_ROI);
    setBackground(null);
    setSourceMode("simulator");
    setSimSeed((seed) => seed + 1);
  };

  const measureValue = experiment === "double" ? analysis?.fringeSpacingMm : analysis?.centralWidthMm;
  const samplingPixels = experiment === "double"
    ? analysis?.periodPx ?? null
    : analysis?.centralWidthMm == null ? null : analysis.centralWidthMm / mmPerPixel / 2;
  const saturationLevel = levelFor(analysis?.saturationRate ?? 0, 0.002, 0.02);
  const samplingLevel: Level = samplingPixels == null ? "warn" : samplingPixels >= 12 ? "good" : samplingPixels >= 7 ? "warn" : "danger";
  const fresnelLevel: Level = analysis?.fresnelNumber == null
    ? "warn"
    : levelFor(analysis.fresnelNumber, 0.1, 0.25);
  const cameraCapabilityText = cameraSnapshot
    ? `${cameraSnapshot.settings.width ?? "?"}×${cameraSnapshot.settings.height ?? "?"}`
    : sourceMode === "simulator" ? "960×540" : "未连接";
  const hasManualExposure = Boolean(cameraSnapshot?.capabilities.exposureMode?.includes("manual"));

  return (
    <main className="lab-app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><span className="brand-symbol" /></span>
          <span className="brand-copy"><strong>FRINGELAB</strong><span>CAMERA-BASED OPTICS BENCH</span></span>
        </div>
        <div className="top-actions">
          <span className={`status-pill ${analysis ? "good" : "warn"}`}>{analysis ? "分析引擎就绪" : "等待信号"}</span>
          <span className={`status-pill ${analysis?.saturationRate && analysis.saturationRate > 0.02 ? "danger" : "good"}`}>
            {analysis?.saturationRate && analysis.saturationRate > 0.02 ? "存在过曝" : "曝光可用"}
          </span>
          <button className="button" type="button" onClick={saveSession}>保存会话</button>
        </div>
      </header>

      <div className="app-shell">
        <section className="intro-strip">
          <div>
            <p className="eyebrow">QUANTITATIVE OPTICS · LOCAL FIRST</p>
            <h1>把光屏上的条纹，<span>变成可追溯的波长数据。</span></h1>
            <p>
              从摄像头 DN 提取相对光强剖面，用旋转 ROI 平均降噪，再以单缝暗纹或双缝多级亮纹反演激光波长。纵轴是相机响应的任意单位，不是 lux。
            </p>
          </div>
          <div className="workflow" aria-label="实验流程">
            {["采集", "ROI", "标定", "拟合", "导出"].map((step, index) => (
              <span className={`workflow-step ${index <= (analysis ? 3 : 1) ? "active" : ""}`} key={step}>
                <span className="step-index">{index + 1}</span>{step}
              </span>
            ))}
          </div>
        </section>

        <section className="workspace-grid">
          <article className="panel stage-panel">
            <div className="panel-header">
              <h2 className="panel-title">光学画面 <small>FRAME / ROI</small></h2>
              <div className="source-tabs" aria-label="输入源">
                <button className={`source-tab ${sourceMode === "simulator" ? "active" : ""}`} type="button" onClick={stopCamera}>仿真</button>
                <button className={`source-tab ${sourceMode === "camera" ? "active" : ""}`} type="button" onClick={startCamera}>摄像头</button>
                <label
                  className={`source-tab upload-button ${sourceMode === "image" ? "active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") event.currentTarget.click();
                  }}
                >
                  图片<input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImageUpload} />
                </label>
              </div>
            </div>
            <div className="stage-body">
              <div className="frame-wrap">
                <video ref={videoRef} className="hidden-video" muted playsInline />
                <canvas ref={frameCanvasRef} className="frame-canvas" aria-label="干涉或衍射光斑帧" />
                <canvas
                  ref={overlayCanvasRef}
                  className="overlay-canvas"
                  aria-label="可拖动分析区域"
                  tabIndex={0}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onKeyDown={handleOverlayKeyDown}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerCancel}
                />
                <div className="frame-hud">
                  <span className="hud-chip">SRC {sourceMode.toUpperCase()}</span>
                  <span className="hud-chip">{cameraCapabilityText}</span>
                  <span className="hud-chip">ROI {Math.round(roi.width)}×{Math.round(roi.height)} px</span>
                  <span className="hud-chip">CH {analysis?.selectedChannel.toUpperCase() ?? channel.toUpperCase()}</span>
                </div>
                <div className="laser-safety">⚠ 只拍摄光屏的漫反射图样；不要让激光直接进入眼睛、摄像头或镜面反射路径。</div>
              </div>
              <div className="stage-footer">
                <div className="micro-card">
                  <div className="micro-card-label">INPUT STATUS</div>
                  <div className="micro-card-value"><span>{sourceMode === "simulator" ? "物理仿真" : sourceMode === "camera" ? cameraSnapshot?.label ?? "Camera" : "实验图片"}</span><span>{isFrozen ? "FROZEN" : "LIVE"}</span></div>
                </div>
                <div className="micro-card">
                  <div className="micro-card-label">SPATIAL SCALE</div>
                  <div className="micro-card-value"><span>{formatNumber(mmPerPixel, 5)} mm/px</span><span>{calibrationPoints.length === 2 ? "2-POINT" : "MANUAL"}</span></div>
                </div>
                <div className="micro-card">
                  <div className="micro-card-label">SIGNAL RANGE</div>
                  <div className="micro-card-value"><span>{formatNumber(analysis?.dynamicRange ?? null, 1)} DN</span><span>SAT {formatNumber((analysis?.saturationRate ?? 0) * 100, 2)}%</span></div>
                </div>
              </div>
            </div>
          </article>

          <article className="panel analysis-panel">
            <div className="panel-header">
              <h2 className="panel-title">实时分析 <small>PROFILE / FIT</small></h2>
              <span className="panel-kicker">{analysis?.status ?? "NO DATA"}</span>
            </div>
            <div className="analysis-body">
              <div className="metric-grid">
                <div className="metric-card primary">
                  <div className="metric-label">测量波长 λ</div>
                  <div className="metric-value">{formatNumber(analysis?.wavelengthNm ?? null, 1)}<em>nm</em></div>
                  <div className="metric-note">95% 扩展不确定度 ± {formatNumber(analysis?.uncertaintyNm ?? null, 1)} nm</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">{experiment === "double" ? "条纹间距 Δx" : "中央主极大 W₀"}</div>
                  <div className="metric-value">{formatNumber(measureValue ?? null, 3)}<em>mm</em></div>
                  <div className="metric-note">{experiment === "double" ? `${analysis?.peaks.length ?? 0} 个亮峰` : `FWHM ${formatNumber(analysis?.fwhmMm ?? null, 3)} mm`}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">参考值偏差</div>
                  <div className="metric-value">{formatNumber(analysis?.referenceErrorPct ?? null, 2)}<em>%</em></div>
                  <div className="metric-note">参考 {formatNumber(referenceWavelengthNm, 0)} nm · R² {formatNumber(analysis?.regressionR2 ?? null, 4)}</div>
                </div>
              </div>

              <div className="chart-card">
                <div className="chart-card-header">
                  <span className="chart-card-title">相对光强剖面</span>
                  <div className="chart-legend">
                    <span className="legend-item"><span className="legend-line raw" />原始 DN</span>
                    <span className="legend-item"><span className="legend-line" />平滑</span>
                    <label className="model-toggle" title="显示或隐藏理想模型拟合曲线">
                      <input
                        type="checkbox"
                        checked={showModelFit}
                        onChange={(event) => setShowModelFit(event.currentTarget.checked)}
                      />
                      <span className={`legend-item ${showModelFit ? "" : "muted"}`}>
                        <span className="legend-line model" />理想模型拟合
                      </span>
                    </label>
                  </div>
                </div>
                <div className="chart-wrap">
                  <canvas
                    ref={chartCanvasRef}
                    className="chart-canvas"
                    aria-label="相对光强随位置曲线"
                    data-display-ceiling={CHART_DISPLAY_CEILING}
                    data-model-visible={String(showModelFit)}
                  />
                </div>
                <div className="axis-caption"><span>归一化相机响应（a.u.，峰值≤98%）</span><span>屏面位置 / mm</span></div>
              </div>

              <div className="quality-card">
                <div className="quality-header"><span>测量质量门控</span><span>{[saturationLevel, samplingLevel, fresnelLevel].every((level) => level === "good") ? "PASS" : "CHECK"}</span></div>
                <div className="quality-list">
                  <QualityItem label="饱和像素" value={`${formatNumber((analysis?.saturationRate ?? 0) * 100, 2)}%`} level={saturationLevel} />
                  <QualityItem label="条纹采样" value={`${formatNumber(samplingPixels, 1)} px`} level={samplingLevel} />
                  <QualityItem label="Fraunhofer 数" value={formatNumber(analysis?.fresnelNumber ?? null, 4)} level={fresnelLevel} />
                  <QualityItem label="空间标定" value={`${formatNumber(mmPerPixel, 5)} mm/px`} level={mmPerPixel > 0 ? "good" : "danger"} />
                  <QualityItem label="曝光锁定" value={sourceMode === "camera" ? cameraLocked ? "LOCKED" : hasManualExposure ? "AVAILABLE" : "UNAVAILABLE" : "N/A"} level={sourceMode !== "camera" || cameraLocked ? "good" : "warn"} />
                  <QualityItem label="小角差异" value={`${formatNumber(analysis?.smallAngleDifferencePct ?? null, 3)}%`} level={(analysis?.smallAngleDifferencePct ?? 0) < 0.5 ? "good" : "warn"} />
                </div>
              </div>
            </div>
          </article>
        </section>

        <section className="control-deck">
          <article className="panel control-panel">
            <div className="control-title-row"><h2 className="control-title">① 光路与采集</h2><span className="control-index">SOURCE</span></div>
            <div className="segmented">
              <button type="button" className={`segment-button ${experiment === "double" ? "active" : ""}`} onClick={() => setExperiment("double")}>双缝干涉</button>
              <button type="button" className={`segment-button ${experiment === "single" ? "active" : ""}`} onClick={() => setExperiment("single")}>单缝衍射</button>
            </div>
            <div className="divider" />
            <div className="field-grid">
              <FieldNumber label="缝宽 a" value={slitWidthMm} unit="mm" min={0.001} step={0.001} onChange={setSlitWidthMm} />
              {experiment === "double" ? <FieldNumber label="双缝中心距 d" value={slitSeparationMm} unit="mm" min={0.002} step={0.001} onChange={setSlitSeparationMm} /> : <FieldNumber label="a 标准不确定度" value={apertureUncertaintyMm} unit="mm" min={0} step={0.001} onChange={setApertureUncertaintyMm} />}
              <FieldNumber label="缝到屏距离 L" value={screenDistanceM} unit="m" min={0.01} step={0.01} onChange={setScreenDistanceM} />
              <FieldNumber label="标准波长（仅作对照）" value={referenceWavelengthNm} unit="nm" min={300} max={1000} step={1} onChange={setReferenceWavelengthNm} />
              {experiment === "double" ? <FieldNumber label="d 标准不确定度" value={apertureUncertaintyMm} unit="mm" min={0} step={0.001} onChange={setApertureUncertaintyMm} /> : null}
              <FieldNumber label="L 标准不确定度" value={distanceUncertaintyM} unit="m" min={0} step={0.001} onChange={setDistanceUncertaintyM} />
            </div>
            <div className="divider" />
            <div className="button-row">
              <button type="button" className="button" onClick={() => selectPreset("double", 650)}>650 nm 双缝</button>
              <button type="button" className="button" onClick={() => selectPreset("single", 532)}>532 nm 单缝</button>
              <button type="button" className="button" onClick={() => setSimSeed((seed) => seed + 1)}>更换噪声</button>
            </div>
            <div className="divider" />
            <div className="field-grid three">
              <FieldNumber label="仿真噪声 σ" value={simNoise} min={0} max={0.1} step={0.002} onChange={setSimNoise} />
              <FieldNumber label="编码 gamma" value={simGamma} min={0.3} max={3} step={0.1} onChange={setSimGamma} />
              <FieldNumber label="剪切阈值" value={simSaturation} min={0.1} max={1} step={0.02} onChange={setSimSaturation} />
            </div>
            {cameraError ? <div className="notice danger">{cameraError}</div> : null}
            <div className="button-row space-top-sm">
              <button type="button" className="button primary" onClick={startCamera}>{cameraSnapshot ? "重启摄像头" : "打开摄像头"}</button>
              <button type="button" className="button" disabled={!cameraSnapshot} onClick={lockCamera}>锁定可用设置</button>
              <button type="button" className="button danger" disabled={!cameraSnapshot} onClick={stopCamera}>断开</button>
            </div>
            {devices.length > 0 ? (
              <div className="field space-top-sm">
                <label htmlFor="camera-device">视频输入</label>
                <select id="camera-device" value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.currentTarget.value)}>
                  <option value="">系统默认</option>
                  {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
                </select>
              </div>
            ) : null}
          </article>

          <article className="panel control-panel">
            <div className="control-title-row"><h2 className="control-title">② ROI 与空间标定</h2><span className="control-index">GEOMETRY</span></div>
            <div className="field-grid">
              <div className="field full">
                <label htmlFor="roi-length">ROI 长度 · {Math.round(roi.width)} px</label>
                <input id="roi-length" type="range" min={ROI_MIN_WIDTH} max={ROI_MAX_WIDTH} step={1} value={roi.width} onChange={(event) => setRoi((current) => ({ ...current, width: Number(event.currentTarget.value) }))} />
              </div>
              <div className="field full">
                <label htmlFor="roi-thickness">ROI 厚度 · {Math.round(roi.height)} px（沿条纹平均）</label>
                <input id="roi-thickness" type="range" min={ROI_MIN_HEIGHT} max={ROI_MAX_HEIGHT} step={1} value={roi.height} onChange={(event) => setRoi((current) => ({ ...current, height: Number(event.currentTarget.value) }))} />
              </div>
              <div className="field full">
                <label htmlFor="roi-angle">ROI 角度 · {roi.angleDeg.toFixed(1)}°</label>
                <input id="roi-angle" type="range" min={-30} max={30} step={0.1} value={roi.angleDeg} onChange={(event) => setRoi((current) => ({ ...current, angleDeg: Number(event.currentTarget.value) }))} />
              </div>
              <div className="field">
                <label htmlFor="fringe-orientation">条纹方向</label>
                <select id="fringe-orientation" value={orientation} onChange={(event) => setOrientation(event.currentTarget.value as FringeOrientation)}>
                  <option value="vertical">竖向（沿 x 变化）</option>
                  <option value="horizontal">横向（沿 y 变化）</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="profile-channel">分析通道</label>
                <select id="profile-channel" value={channel} onChange={(event) => setChannel(event.currentTarget.value as RequestedProfileChannel)}>
                  <option value="auto">自动最佳通道</option>
                  <option value="r">R 红通道</option>
                  <option value="g">G 绿通道</option>
                  <option value="b">B 蓝通道</option>
                  <option value="luminance">亮度 Y</option>
                </select>
              </div>
              <FieldNumber label="空间比例" value={mmPerPixel} unit="mm/px" min={0.00001} step={0.00001} onChange={setMmPerPixel} />
              <FieldNumber label="标定长度" value={calibrationLengthMm} unit="mm" min={0.001} step={0.1} onChange={setCalibrationLengthMm} />
              <FieldNumber label="标定相对不确定度" value={calibrationUncertaintyPct} unit="%" min={0} step={0.1} onChange={setCalibrationUncertaintyPct} />
              <FieldNumber label="高斯平滑 σ" value={smoothingSigma} unit="px" min={0} max={10} step={0.1} onChange={setSmoothingSigma} />
            </div>
            <div className="button-row space-top-md">
              <button type="button" className={`button ${calibrationMode ? "warn" : "primary"}`} onClick={() => { setCalibrationMode((value) => !value); setCalibrationPoints([]); }}>
                {calibrationMode ? "取消标定" : "两点标定"}
              </button>
              <button type="button" className="button" onClick={() => setRoi(DEFAULT_ROI)}>重置 ROI</button>
              <button type="button" className="button" onClick={freezeCurrentFrame}>冻结当前帧</button>
            </div>
            <div className={`notice space-top-sm ${calibrationMode ? "warn" : ""}`}>
              {calibrationMode ? `请在画面标尺上依次点击两端，实际距离设为 ${calibrationLengthMm} mm。` : "拖动 ROI 内部改变位置；拖动四角方块调整长宽；调整角度使采样轴垂直于条纹。"}
            </div>
            <div className="button-row space-top-sm">
              <button type="button" className="button" disabled={!analysis} onClick={() => { setBackground(analysis?.raw ?? null); setToast("已采集当前 ROI 为背景"); }}>采集背景</button>
              <button type="button" className="button" disabled={!background} onClick={() => setBackground(null)}>清除背景</button>
            </div>
          </article>

          <article className="panel control-panel">
            <div className="control-title-row"><h2 className="control-title">③ 结果、质量与导出</h2><span className="control-index">REPORT</span></div>
            {analysisError ? <div className="notice danger">{analysisError}</div> : null}
            {analysis && analysis.saturationRate > 0.02 ? <div className="notice danger">峰顶存在饱和或平台，峰高与 FWHM 不可信。请降低曝光、ISO 或加衰减片；条纹位置结果仅降级使用。</div> : null}
            {analysis?.fresnelNumber != null && analysis.fresnelNumber >= 0.1 ? <div className="notice warn space-top-xs">Fresnel 数 {analysis.fresnelNumber.toFixed(3)} 不足够小，Fraunhofer 远场模型可能带来系统偏差。增大 L 或减小孔径尺寸后复测。</div> : null}
            <div className="divider" />
            <div className="results-table-wrap">
              <table className="results-table">
                <thead><tr><th>特征</th><th>级次</th><th>位置 / mm</th><th>幅度 / a.u.</th><th>宽度 / px</th></tr></thead>
                <tbody>
                  {(experiment === "double" ? analysis?.peaks : analysis?.troughs)?.map((mark, index) => (
                    <tr key={`${mark.type}-${index}`}>
                      <td>{mark.type === "peak" ? mark.saturated ? "饱和峰" : "亮峰" : "暗纹"}</td>
                      <td>{mark.order ?? "—"}</td>
                      <td>{formatNumber(mark.positionMm, 4)}</td>
                      <td>{formatNumber(mark.value, 2)}</td>
                      <td>{formatNumber(mark.width, 2)}</td>
                    </tr>
                  )) ?? <tr><td colSpan={5}>暂无特征</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="divider" />
            <div className="button-row">
              <button type="button" className="button primary" disabled={!analysis} onClick={exportCsv}>导出 CSV</button>
              <button type="button" className="button" disabled={!analysis} onClick={exportJson}>导出 JSON</button>
              <button type="button" className="button" disabled={!analysis} onClick={exportPng}>曲线 PNG</button>
              <button type="button" className="button" onClick={loadSession}>恢复会话</button>
            </div>
            <div className="divider" />
            <details className="notice">
              <summary>本项目究竟测量什么？</summary>
              <p>光屏承受的是辐照度，相机观测的是屏幕散射辐亮度经镜头、传感器与 ISP 处理后的数字量 DN。未经辐射定标时，本工具输出“相对光强（相机响应）”和条纹空间位置，不输出 lux 或 W/m²。</p>
            </details>
            <details className="notice space-top-xs">
              <summary>使用的物理模型</summary>
              <p>双缝使用 sinc² 包络调制 cos² 干涉项，并回归 d·sinθ = mλ；单缝使用 sinc² 分布和 a·sinθ = nλ。坐标默认经 sin(arctan(x/L)) 精确转换，同时给出小角结果作对照。</p>
            </details>
          </article>
        </section>

        <footer className="footer-note">
          <span>FringeLab · 数据默认仅在当前浏览器处理，摄像头帧不上传。</span>
          <span>科学边界：摄像头 DN ≠ 照度 lux · 饱和峰不用于峰高/FWHM · 报告必须保留 a/d、L 与标定信息。</span>
        </footer>
      </div>
      {toast ? <div className="status-pill good floating-toast" role="status">{toast}</div> : null}
    </main>
  );
}
