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
import { analyseFrame, type Analysis, type AnalysisConfig } from "@/lib/analysis";
import { validateSpatialAnchors, type SpatialAnchor } from "@/lib/spatial";
import { decodeExperimentImage } from "@/lib/image-input";
import { recognizeRulerReadings } from "@/lib/ruler-ocr";
import {
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
import {
  calculateCalibrationUncertaintyPct as rulerUncertaintyPct,
  calculateMmPerPixel as rulerMmPerPixel,
  generateRulerTicks,
  hitTestRuler,
  moveRuler,
  resizeRulerEndpoint,
  rulerAngleDeg,
  rulerLengthPx,
  suggestRulerAlignment,
  type RulerCalibration,
} from "@/lib/ruler";
import {
  clientPointToImagePoint,
  detectPhysicalRuler,
  resolveRulerTheme,
  resolveRulerThemeFromSamples,
  rulerFromDetection,
  snapRulerToDetection,
  type RulerContrastMode,
  type RulerDetectionResult,
  type RulerRegion,
  type RulerTheme,
} from "@/lib/ruler-detection";

type SourceMode = "simulator" | "camera" | "image";
type ExperimentMode = "double" | "single";
type Level = "good" | "warn" | "danger";
type SpatialCalibrationSource =
  | "multi-point"
  | "manual-scale"
  | "two-point"
  | "physical-ruler-overlay"
  | "physical-ruler-perspective";

type CanvasInteractionMode =
  | "multi-point-calibration"
  | "roi"
  | "two-point-calibration"
  | "ruler-region-selection"
  | "ruler-auto-detection"
  | "ruler-overlay-adjustment"
  | "ruler-perspective-adjustment"
  | "none";

type Roi = RoiGeometry;

type RoiInteraction =
  | { mode: "move"; startPoint: Point; startRoi: Roi }
  | { mode: "resize"; corner: RoiCorner; startRoi: Roi };

type RulerInteraction =
  | { mode: "move"; startPoint: Point; startRuler: RulerCalibration }
  | { mode: "resize"; handle: "start" | "end"; startRuler: RulerCalibration };




const FRAME_WIDTH = 960;
const FRAME_HEIGHT = 540;
const ROI_MIN_WIDTH = 80;
const ROI_MIN_HEIGHT = 24;
const ROI_MAX_WIDTH = 930;
const ROI_MAX_HEIGHT = 420;
const ROI_HANDLE_HIT_RADIUS = 18;
const MIN_RULER_LENGTH_PX = 80;
const DEFAULT_ROI: Roi = {
  centerX: FRAME_WIDTH / 2,
  centerY: FRAME_HEIGHT / 2,
  width: 820,
  height: 116,
  angleDeg: 0,
};
const DEFAULT_RULER: RulerCalibration = {
  start: { x: 180, y: 430 },
  end: { x: 780, y: 430 },
  knownLengthMm: 50,
  tickSide: -1,
};
const DEFAULT_RULER_THEME = resolveRulerThemeFromSamples([20, 24, 28, 32], "auto");

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}




function formatNumber(value: number | null, digits = 2, fallback = "—"): string {
  return value == null || !Number.isFinite(value) ? fallback : value.toFixed(digits);
}

function levelFor(value: number, goodBelow: number, warnBelow: number): Level {
  if (value < goodBelow) return "good";
  if (value < warnBelow) return "warn";
  return "danger";
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const roiInteractionRef = useRef<RoiInteraction | null>(null);
  const rulerInteractionRef = useRef<RulerInteraction | null>(null);
  const rulerRegionStartRef = useRef<Point | null>(null);
  const rulerWorkerRef = useRef<Worker | null>(null);
  const rulerDetectionRequestRef = useRef(0);

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
  const [hasReference, setHasReference] = useState(false);
  const [slitWidthKnown, setSlitWidthKnown] = useState(false);
  const [parametersConfirmed, setParametersConfirmed] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [imageLoading, setImageLoading] = useState(false);
  const [sourceResolution, setSourceResolution] = useState("960×540");
  const [sourceFilename, setSourceFilename] = useState<string | null>(null);
  const [captureSettings, setCaptureSettings] = useState<CameraSnapshot | null>(null);
  const [spatialAnchors, setSpatialAnchors] = useState<SpatialAnchor[]>([]);
  const [draftAnchors, setDraftAnchors] = useState<SpatialAnchor[]>([]);
  const [anchorReading, setAnchorReading] = useState(0);
  const [rulerUnit, setRulerUnit] = useState<"cm" | "mm">("cm");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrMessage, setOcrMessage] = useState("");
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
  const [imageLoaded, setImageLoaded] = useState(false);
  const [calibrationMode, setCalibrationMode] = useState(false);
  const [calibrationPoints, setCalibrationPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [twoPointDistanceMm, setTwoPointDistanceMm] = useState(50);
  const [ruler, setRuler] = useState<RulerCalibration>(DEFAULT_RULER);
  const [rulerMode, setRulerMode] = useState(false);
  const [canvasInteractionMode, setCanvasInteractionMode] = useState<CanvasInteractionMode>("roi");
  const [calibrationSource, setCalibrationSource] = useState<SpatialCalibrationSource>("manual-scale");
  const [calibrationStale, setCalibrationStale] = useState(false);
  const [rulerFitConfidence, setRulerFitConfidence] = useState<number | null>(null);
  const [rulerPanelOpen, setRulerPanelOpen] = useState(false);
  const [rulerContrastMode, setRulerContrastMode] = useState<RulerContrastMode>("auto");
  const [rulerTheme, setRulerTheme] = useState<RulerTheme>(DEFAULT_RULER_THEME);
  const [rulerDetection, setRulerDetection] = useState<RulerDetectionResult | null>(null);
  const [rulerDetectionState, setRulerDetectionState] = useState<"idle" | "detecting" | "candidate" | "applied" | "failed" | "stale">("idle");
  const [rulerDetectionProgress, setRulerDetectionProgress] = useState(0);
  const [rulerRegion, setRulerRegion] = useState<RulerRegion | null>(null);
  const [tickSnapEnabled, setTickSnapEnabled] = useState(true);
  const [numberSnapEnabled, setNumberSnapEnabled] = useState(true);
  const [manualOriginMm, setManualOriginMm] = useState(0);
  const [lowConfidenceConfirmed, setLowConfidenceConfirmed] = useState(false);
  const [snapHighlight, setSnapHighlight] = useState<string | null>(null);
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
    spatialAnchors: calibrationSource === "multi-point" ? spatialAnchors : [],
    hasReference: sourceMode === "simulator" || hasReference,
    slitWidthKnown: sourceMode === "simulator" || experiment === "single" || slitWidthKnown,
    measurementReady: sourceMode === "simulator" || (parametersConfirmed && !calibrationStale && !imageLoading),
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
    spatialAnchors, calibrationSource, hasReference, slitWidthKnown, sourceMode, parametersConfirmed, calibrationStale, imageLoading,
  ]);

  const processCurrentCanvas = useCallback(() => {
    const canvas = frameCanvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    try {
      const native = sourceMode !== "simulator" ? sourceCanvasRef.current : null;
      const nativeContext = native?.getContext("2d", { willReadFrequently: true });
      if (native && nativeContext) {
        const scale = Math.min(FRAME_WIDTH / native.width, FRAME_HEIGHT / native.height);
        const offsetX = (FRAME_WIDTH - native.width * scale) / 2;
        const offsetY = (FRAME_HEIGHT - native.height * scale) / 2;
        const toNative = (point: Point) => ({ x: (point.x - offsetX) / scale, y: (point.y - offsetY) / scale });
        const result = analyseFrame(nativeContext.getImageData(0, 0, native.width, native.height), {
          ...config,
          roi: { ...config.roi, centerX: toNative({ x: roi.centerX, y: roi.centerY }).x, centerY: toNative({ x: roi.centerX, y: roi.centerY }).y, width: roi.width / scale, height: roi.height / scale },
          mmPerPixel: config.mmPerPixel * scale,
          smoothingSigma: config.smoothingSigma / scale,
          spatialAnchors: config.spatialAnchors?.map((anchor) => ({ ...toNative(anchor), mm: anchor.mm })),
        });
        setAnalysis(result);
      } else {
        setAnalysis(analyseFrame(context.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT), config));
      }
      setAnalysisError(null);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "帧分析失败");
    }
  }, [config, sourceMode, roi]);

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
      rulerWorkerRef.current?.terminate();
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
        if (timestamp - lastFrameRef.current > 250) {
          lastFrameRef.current = timestamp;
          const source = sourceCanvasRef.current ?? document.createElement("canvas");
          sourceCanvasRef.current = source;
          source.width = video.videoWidth || 1280;
          source.height = video.videoHeight || 720;
          source.getContext("2d", { willReadFrequently: true })?.drawImage(video, 0, 0);
          setSourceResolution(`${source.width}×${source.height}`);
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
    if (sourceMode === "camera" && isFrozen) processCurrentCanvas();
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
  }, [sourceMode, sourceRevision, processCurrentCanvas]);

  useEffect(() => {
    if (!rulerMode) return;
    const canvas = frameCanvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    try {
      setRulerTheme(resolveRulerTheme(
        context.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT),
        ruler,
        rulerContrastMode,
      ));
    } catch {
      setRulerTheme(resolveRulerThemeFromSamples([24, 30, 36], rulerContrastMode));
    }
  }, [ruler, rulerMode, rulerContrastMode, sourceMode]);

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

    const anchors = canvasInteractionMode === "multi-point-calibration" ? draftAnchors : spatialAnchors;
    if (anchors.length) {
      context.save();
      context.font = "bold 12px monospace";
      anchors.forEach((point) => {
        context.strokeStyle = "#071019";
        context.lineWidth = 5;
        context.fillStyle = "#59f4e0";
        context.beginPath(); context.arc(point.x, point.y, 5, 0, Math.PI * 2); context.stroke(); context.fill();
        const label = `${point.mm} mm`;
        context.strokeText(label, point.x + 7, point.y - 10);
        context.fillText(label, point.x + 7, point.y - 10);
      });
      context.restore();
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

    if (rulerRegion) {
      context.save();
      context.strokeStyle = "#ff5bd7";
      context.fillStyle = "rgba(255,91,215,.07)";
      context.lineWidth = 2;
      context.setLineDash([7, 5]);
      context.fillRect(rulerRegion.x, rulerRegion.y, rulerRegion.width, rulerRegion.height);
      context.strokeRect(rulerRegion.x, rulerRegion.y, rulerRegion.width, rulerRegion.height);
      context.restore();
    }

    if (rulerDetection && (rulerMode || rulerDetectionState === "candidate")) {
      context.save();
      context.strokeStyle = "rgba(89,244,224,.7)";
      context.lineWidth = 1.25;
      context.setLineDash([5, 4]);
      context.beginPath();
      rulerDetection.rulerBodyCorners.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.closePath();
      context.stroke();
      context.setLineDash([]);
      for (const tick of rulerDetection.ticks.filter((item) => item.inlier && item.kind !== "minor")) {
        context.beginPath();
        context.arc(tick.point.x, tick.point.y, tick.kind === "major" ? 4 : 2.5, 0, Math.PI * 2);
        context.fillStyle = tick.kind === "major" ? "#59f4e0" : "rgba(89,244,224,.7)";
        context.fill();
      }
      context.restore();
    }

    if (rulerMode) {
      const length = rulerLengthPx(ruler);
      const angleRadians = rulerAngleDeg(ruler) * Math.PI / 180;
      const ticks = generateRulerTicks(ruler);
      const scale = rulerMmPerPixel(ruler);
      const tickSide = ruler.tickSide ?? -1;
      const bodyTop = tickSide === 1 ? -2 : -40;
      const drawOutlinedStroke = (drawPath: () => void, width = 1.6) => {
        context.beginPath();
        drawPath();
        context.strokeStyle = rulerTheme.outline;
        context.lineWidth = rulerTheme.complexBackground ? width + 4.2 : width + 3;
        context.stroke();
        context.beginPath();
        drawPath();
        context.strokeStyle = rulerTheme.stroke;
        context.lineWidth = width;
        context.stroke();
      };
      const drawOutlinedText = (text: string, x: number, y: number) => {
        context.lineJoin = "round";
        context.strokeStyle = rulerTheme.outline;
        context.lineWidth = rulerTheme.complexBackground ? 4 : 3;
        context.strokeText(text, x, y);
        context.fillStyle = rulerTheme.stroke;
        context.fillText(text, x, y);
      };
      context.save();
      context.translate(ruler.start.x, ruler.start.y);
      context.rotate(angleRadians);
      context.fillStyle = rulerTheme.fill;
      context.fillRect(0, bodyTop, length, 42);
      drawOutlinedStroke(() => context.rect(0, bodyTop, length, 42));
      drawOutlinedStroke(() => { context.moveTo(0, 0); context.lineTo(length, 0); }, 2);
      context.font = "bold 9px monospace";
      context.textAlign = "center";
      for (const tick of ticks) {
        const x = Math.hypot(tick.point.x - ruler.start.x, tick.point.y - ruler.start.y);
        const height = tick.kind === "major" ? 24 : tick.kind === "medium" ? 16 : 9;
        drawOutlinedStroke(() => {
          context.moveTo(x, 0);
          context.lineTo(x, height * tickSide);
        }, tick.kind === "major" ? 1.9 : 1.35);
        if (tick.kind === "major") {
          const label = (tick.millimetre + (ruler.originMm ?? 0)).toFixed(0);
          drawOutlinedText(label, x, (height + 5) * tickSide + (tickSide === 1 ? 8 : 0));
        }
      }
      // Rotation cue: a compact arc and direction ray share the same contrast treatment.
      drawOutlinedStroke(() => {
        context.arc(0, 0, 17, tickSide === 1 ? -0.55 : 0.55, 0, tickSide === -1);
        context.moveTo(0, 0);
        context.lineTo(17, 0);
      }, 1.2);
      context.restore();

      for (const point of [ruler.start, ruler.end]) {
        context.beginPath();
        context.arc(point.x, point.y, 9, 0, Math.PI * 2);
        context.fillStyle = rulerTheme.handleFill;
        context.fill();
        context.lineWidth = 5;
        context.strokeStyle = rulerTheme.outline;
        context.stroke();
        context.beginPath();
        context.arc(point.x, point.y, 9, 0, Math.PI * 2);
        context.lineWidth = 2.5;
        context.strokeStyle = rulerTheme.stroke;
        context.stroke();
        context.beginPath();
        context.arc(point.x, point.y, 3, 0, Math.PI * 2);
        context.fillStyle = rulerTheme.stroke;
        context.fill();
      }

      const midpoint = {
        x: (ruler.start.x + ruler.end.x) / 2,
        y: (ruler.start.y + ruler.end.y) / 2,
      };
      const summary = `${ruler.knownLengthMm.toFixed(1)} mm · ${length.toFixed(1)} px · ${scale?.toFixed(5) ?? "—"} mm/px · ${rulerAngleDeg(ruler).toFixed(1)}°`;
      context.font = "bold 11px monospace";
      context.textAlign = "center";
      const summaryWidth = context.measureText(summary).width + 18;
      const labelY = clamp(midpoint.y + 34, 22, FRAME_HEIGHT - 8);
      context.fillStyle = rulerTheme.labelFill;
      context.fillRect(
        clamp(midpoint.x - summaryWidth / 2, 4, FRAME_WIDTH - summaryWidth - 4),
        labelY - 16,
        summaryWidth,
        22,
      );
      context.strokeStyle = rulerTheme.outline;
      context.lineWidth = rulerTheme.complexBackground ? 4 : 3;
      const labelX = clamp(midpoint.x, summaryWidth / 2 + 4, FRAME_WIDTH - summaryWidth / 2 - 4);
      context.strokeText(summary, labelX, labelY);
      context.fillStyle = rulerTheme.labelText;
      context.fillText(summary, labelX, labelY);

      if (snapHighlight) {
        context.font = "bold 10px monospace";
        context.fillStyle = "#59f4e0";
        context.fillText(`MAGNET · ${snapHighlight}`, midpoint.x, clamp(midpoint.y - 50, 16, FRAME_HEIGHT - 16));
      }
    }
  }, [
    roi,
    calibrationPoints,
    ruler,
    rulerMode,
    rulerTheme,
    rulerRegion,
    rulerDetection,
    rulerDetectionState,
    snapHighlight,
    draftAnchors, spatialAnchors, canvasInteractionMode,
  ]);

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
      const axis = analysis.measurementReady ? analysis.axisMm : analysis.axisPx;
      const axisIndex = Math.round((axis.length - 1) * index / 6);
      context.fillText(formatNumber(axis[axisIndex] ?? 0, 1), x - 10, height - 7);
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
    if (showModelFit && config.slitWidthKnown && analysis.measurementReady) {
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
  }, [analysis, showModelFit, config.slitWidthKnown]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const invalidateRulerCalibrationForNewSource = () => {
    setCalibrationStale(true);
    setRulerDetectionState("stale");
    setBackground(null);
    setSpatialAnchors([]);
    setDraftAnchors([]);
    setOcrMessage("");
    rulerDetectionRequestRef.current += 1;
    rulerWorkerRef.current?.terminate();
    rulerWorkerRef.current = null;
    setRulerMode(false);
    setCanvasInteractionMode("roi");
    setCalibrationMode(false);
    setCalibrationPoints([]);
    setRulerFitConfidence(null);
    setRulerRegion(null);
    setSnapHighlight(null);
  };

  const startCamera = async () => {
    setCameraError(null);
    setCameraLocked(false);
    try {
      closeCamera(streamRef.current);
      const result = await openCamera(selectedDeviceId || undefined);
      invalidateRulerCalibrationForNewSource();
      streamRef.current = result.stream;
      setCameraSnapshot(result.snapshot);
      setCaptureSettings(result.snapshot);
      setSourceFilename(null);
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
    if (sourceMode !== "simulator") invalidateRulerCalibrationForNewSource();
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
      setCameraLocked(settings.exposureMode === "manual");
      setCaptureSettings(snapshot);
      setToast("已尝试锁定浏览器允许的曝光、对焦和白平衡");
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : "浏览器不允许锁定设置");
    }
  };

  const handleImageUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    event.currentTarget.value = "";
    // Invalidate immediately, not after a potentially slow HEIC decode: never
    // display the previous image's wavelength as the newly selected result.
    invalidateRulerCalibrationForNewSource();
    setImageLoading(true);
    setAnalysisError(null);
    try {
      const image = await decodeExperimentImage(file);
      closeCamera(streamRef.current);
      streamRef.current = null;
      setCameraSnapshot(null);
      setCameraLocked(false);
      imageRef.current = image;
      setSourceFilename(file.name);
      setCaptureSettings(null);
      const native = document.createElement("canvas");
      native.width = image.naturalWidth;
      native.height = image.naturalHeight;
      native.getContext("2d", { willReadFrequently: true })?.drawImage(image, 0, 0);
      sourceCanvasRef.current = native;
      setSourceResolution(`${native.width}×${native.height}`);
      setSourceRevision((value) => value + 1);
      setImageLoaded(true);
      setSourceMode("image");
      setIsFrozen(true);
      setToast(`已载入 ${file.name}`);
      setRulerPanelOpen(true);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "图片解码失败");
    } finally { setImageLoading(false); }
  };

  const freezeCurrentFrame = () => {
    const canvas = sourceMode === "camera" ? sourceCanvasRef.current : frameCanvasRef.current;
    if (!canvas) return;
    const image = new Image();
    image.onload = () => {
      closeCamera(streamRef.current);
      streamRef.current = null;
      setCameraSnapshot(null);
      setCameraLocked(false);
      imageRef.current = image;
      const native = document.createElement("canvas");
      native.width = image.naturalWidth; native.height = image.naturalHeight;
      native.getContext("2d", { willReadFrequently: true })?.drawImage(image, 0, 0);
      sourceCanvasRef.current = native;
      setSourceResolution(`${native.width}×${native.height}`);
      setSourceRevision((value) => value + 1);
      setImageLoaded(true);
      setSourceMode("image");
      setIsFrozen(true);
      setToast("已冻结当前帧");
    };
    image.src = canvas.toDataURL("image/png");
  };

  const pointerPosition = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rectangle = event.currentTarget.getBoundingClientRect();
    return clientPointToImagePoint(
      { x: event.clientX, y: event.clientY },
      rectangle,
      { width: FRAME_WIDTH, height: FRAME_HEIGHT },
    );
  };

  const finishRulerDetection = (result: RulerDetectionResult | null, requestId: number) => {
    if (requestId !== rulerDetectionRequestRef.current) return;
    rulerWorkerRef.current?.terminate();
    rulerWorkerRef.current = null;
    setRulerDetectionProgress(100);
    if (!result) {
      setRulerDetectionState("failed");
      setCanvasInteractionMode("none");
      setToast("未可靠识别实物刻度尺，请框选尺子区域后重试");
      return;
    }
    if (result.sourceWidth !== FRAME_WIDTH || result.sourceHeight !== FRAME_HEIGHT) {
      const scale = Math.min(FRAME_WIDTH / result.sourceWidth, FRAME_HEIGHT / result.sourceHeight);
      const offsetX = (FRAME_WIDTH - result.sourceWidth * scale) / 2;
      const offsetY = (FRAME_HEIGHT - result.sourceHeight * scale) / 2;
      const point = (value: Point) => ({ x: value.x * scale + offsetX, y: value.y * scale + offsetY });
      result = { ...result, sourceWidth: FRAME_WIDTH, sourceHeight: FRAME_HEIGHT, start: point(result.start), end: point(result.end), rulerBodyCorners: result.rulerBodyCorners.map(point) as [Point, Point, Point, Point], selectedRegion: { x: result.selectedRegion.x * scale + offsetX, y: result.selectedRegion.y * scale + offsetY, width: result.selectedRegion.width * scale, height: result.selectedRegion.height * scale }, ticks: result.ticks.map((tick) => ({ ...tick, point: point(tick.point), axisPositionPx: tick.axisPositionPx * scale, lengthPx: tick.lengthPx * scale })), fit: { ...result.fit, pixelsPerMm: result.fit.pixelsPerMm * scale, mmPerPixel: result.fit.mmPerPixel / scale, offsetPx: result.fit.offsetPx * scale, residualRmsPx: result.fit.residualRmsPx * scale } };
    }
    const nextRuler = rulerFromDetection(result);
    setRulerDetection(result);
    setRuler(nextRuler);
    setRulerTheme(result.theme);
    setRulerFitConfidence(result.fit.confidence);
    setRulerRegion(result.selectedRegion);
    setRulerMode(true);
    setCalibrationMode(false);
    setCanvasInteractionMode("ruler-overlay-adjustment");
    setRulerDetectionState("candidate");
    setLowConfidenceConfirmed(false);
    setRulerPanelOpen(true);
    setToast(
      `已拟合 ${result.fit.inlierCount}/${result.fit.totalCount} 条刻线，${result.fit.mmPerPixel.toFixed(5)} mm/px；请人工确认`,
    );
  };

  const runPhysicalRulerDetection = (selectedRegion?: RulerRegion) => {
    if (sourceMode === "simulator") {
      setToast("仿真图样已有已知空间比例，无需实物标尺标定");
      return;
    }
    const canvas = sourceCanvasRef.current ?? frameCanvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) {
      setToast("当前没有可分析的图像帧");
      return;
    }
    if (sourceMode === "camera" && !isFrozen) setIsFrozen(true);
    rulerDetectionRequestRef.current += 1;
    const requestId = rulerDetectionRequestRef.current;
    rulerWorkerRef.current?.terminate();
    setRulerDetectionState("detecting");
    setCanvasInteractionMode("ruler-auto-detection");
    setRulerDetectionProgress(12);
    setRulerRegion(selectedRegion ?? null);
    setRulerMode(false);
    setCalibrationMode(false);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const fallbackImageData: ImageDataLike = {
      width: imageData.width,
      height: imageData.height,
      data: new Uint8ClampedArray(imageData.data),
    };
    const sourceType = sourceMode === "camera" ? "camera" : "image";
    const scale = Math.min(FRAME_WIDTH / canvas.width, FRAME_HEIGHT / canvas.height);
    const offsetX = (FRAME_WIDTH - canvas.width * scale) / 2;
    const offsetY = (FRAME_HEIGHT - canvas.height * scale) / 2;
    const options = {
      sourceType,
      region: selectedRegion ? { x: (selectedRegion.x - offsetX) / scale, y: (selectedRegion.y - offsetY) / scale, width: selectedRegion.width / scale, height: selectedRegion.height / scale } : undefined,
      contrastMode: rulerContrastMode,
      tickSnapEnabled,
      numberSnapEnabled,
      manualOriginMm,
    } as const;

    const progressTimer = window.setTimeout(() => {
      if (requestId === rulerDetectionRequestRef.current) setRulerDetectionProgress(58);
    }, 120);
    try {
      const worker = new Worker(new URL("../lib/ruler.worker.ts", import.meta.url), { type: "module" });
      rulerWorkerRef.current = worker;
      worker.onmessage = (event: MessageEvent<{ id: number; result?: RulerDetectionResult | null; error?: string }>) => {
        window.clearTimeout(progressTimer);
        if (event.data.error) {
          finishRulerDetection(null, event.data.id);
          return;
        }
        finishRulerDetection(event.data.result ?? null, event.data.id);
      };
      worker.onerror = () => {
        window.clearTimeout(progressTimer);
        worker.terminate();
        rulerWorkerRef.current = null;
        window.setTimeout(() => {
          finishRulerDetection(detectPhysicalRuler(fallbackImageData, options), requestId);
        }, 0);
      };
      worker.postMessage({
        id: requestId,
        width: imageData.width,
        height: imageData.height,
        buffer: imageData.data.buffer,
        ...options,
      }, [imageData.data.buffer]);
    } catch {
      window.clearTimeout(progressTimer);
      window.setTimeout(() => {
        finishRulerDetection(detectPhysicalRuler(fallbackImageData, options), requestId);
      }, 0);
    }
  };

  const cancelRulerDetection = () => {
    rulerDetectionRequestRef.current += 1;
    rulerWorkerRef.current?.terminate();
    rulerWorkerRef.current = null;
    rulerInteractionRef.current = null;
    rulerRegionStartRef.current = null;
    setRulerMode(false);
    setCalibrationMode(false);
    setCanvasInteractionMode("roi");
    setRulerDetectionProgress(0);
    setRulerRegion(null);
    setSnapHighlight(null);
    setRulerDetectionState(calibrationStale ? "stale" : "idle");
    setToast("已取消标尺识别，空间比例未改变");
  };

  const updateOverlayCursor = (canvas: HTMLCanvasElement, point: Point) => {
    if (canvasInteractionMode === "multi-point-calibration" || canvasInteractionMode === "ruler-region-selection" || canvasInteractionMode === "two-point-calibration") {
      canvas.style.cursor = "crosshair";
      return;
    }
    if (canvasInteractionMode === "ruler-auto-detection") {
      canvas.style.cursor = "progress";
      return;
    }
    if (rulerMode) {
      const handle = hitTestRuler(ruler, point);
      canvas.style.cursor = handle === "body"
        ? "move"
        : handle === "start" || handle === "end" ? "crosshair" : "default";
      return;
    }
    const corner = hitTestRoiCorner(roi, point, ROI_HANDLE_HIT_RADIUS);
    canvas.style.cursor = corner
      ? roiCornerCursor(corner)
      : isPointInsideRoi(roi, point) ? "move" : "crosshair";
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerPosition(event);
    if (canvasInteractionMode === "multi-point-calibration") {
      const mm = anchorReading * (rulerUnit === "cm" ? 10 : 1);
      if (draftAnchors.some((anchor) => anchor.mm === mm)) {
        setToast("此读数已存在，请先改变读数或删除旧点");
        return;
      }
      setDraftAnchors((current) => [...current, { ...point, mm }]);
      setAnchorReading((value) => value + (rulerUnit === "cm" ? 1 : 10));
      return;
    }
    if (canvasInteractionMode === "ruler-auto-detection") return;
    if (canvasInteractionMode === "ruler-region-selection") {
      rulerRegionStartRef.current = point;
      setRulerRegion({ x: point.x, y: point.y, width: 0, height: 0 });
      event.currentTarget.style.cursor = "crosshair";
      return;
    }
    if (calibrationMode) {
      const next = calibrationPoints.length >= 2 ? [point] : [...calibrationPoints, point];
      setCalibrationPoints(next);
      if (next.length === 2) {
        const pixelDistance = Math.hypot(next[1].x - next[0].x, next[1].y - next[0].y);
        if (pixelDistance > 1) {
          setMmPerPixel(twoPointDistanceMm / pixelDistance);
          setCalibrationSource("two-point");
          setSpatialAnchors([]);
          setCalibrationStale(false);
          setCalibrationMode(false);
          setCanvasInteractionMode("roi");
          setToast(`两点标定完成：${(twoPointDistanceMm / pixelDistance).toFixed(5)} mm/px`);
        }
      }
      return;
    }
    if (rulerMode) {
      const handle = hitTestRuler(ruler, point);
      if (handle === "body") {
        rulerInteractionRef.current = { mode: "move", startPoint: point, startRuler: ruler };
        event.currentTarget.style.cursor = "grabbing";
      } else if (handle === "start" || handle === "end") {
        rulerInteractionRef.current = { mode: "resize", handle, startRuler: ruler };
        event.currentTarget.style.cursor = "crosshair";
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
    if (rulerMode) {
      setRuler((previous) => moveRuler(previous, offset[0], offset[1], {
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
      }));
      return;
    }
    setRoi((previous) => ({
      ...previous,
      centerX: clamp(previous.centerX + offset[0], 0, FRAME_WIDTH),
      centerY: clamp(previous.centerY + offset[1], 0, FRAME_HEIGHT),
    }));
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = pointerPosition(event);
    if (canvasInteractionMode === "ruler-auto-detection" || calibrationMode) return;
    if (canvasInteractionMode === "ruler-region-selection") {
      const start = rulerRegionStartRef.current;
      if (!start) return;
      setRulerRegion({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      });
      return;
    }
    if (rulerMode) {
      const interaction = rulerInteractionRef.current;
      if (!interaction) {
        updateOverlayCursor(event.currentTarget, point);
        return;
      }
      let nextRuler: RulerCalibration;
      if (interaction.mode === "move") {
        nextRuler = moveRuler(
          interaction.startRuler,
          point.x - interaction.startPoint.x,
          point.y - interaction.startPoint.y,
          { width: FRAME_WIDTH, height: FRAME_HEIGHT },
        );
      } else {
        nextRuler = resizeRulerEndpoint(
          interaction.startRuler,
          interaction.handle,
          {
            x: clamp(point.x, 0, FRAME_WIDTH),
            y: clamp(point.y, 0, FRAME_HEIGHT),
          },
          event.shiftKey ? 45 : undefined,
        );
      }
      if (rulerDetection && (tickSnapEnabled || numberSnapEnabled) && !event.altKey) {
        const displayScale = event.currentTarget.getBoundingClientRect().width / FRAME_WIDTH;
        const snap = snapRulerToDetection(nextRuler, rulerDetection, {
          tickSnapEnabled,
          numberSnapEnabled,
          displayScale,
        });
        nextRuler = snap.ruler;
        setSnapHighlight(snap.snapped ? snap.target === "number" ? "数字锚点" : snap.target === "tick" ? "毫米刻线" : "尺体长边" : null);
      } else {
        setSnapHighlight(null);
      }
      setRuler(nextRuler);
      setRulerFitConfidence(null);
      return;
    }
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
    if (canvasInteractionMode === "ruler-region-selection" && rulerRegionStartRef.current) {
      const start = rulerRegionStartRef.current;
      const point = pointerPosition(event);
      const selectedRegion = {
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      };
      rulerRegionStartRef.current = null;
      if (selectedRegion.width >= 28 && selectedRegion.height >= 20) {
        runPhysicalRulerDetection(selectedRegion);
      } else {
        setRulerRegion(null);
        setToast("框选区域太小，请完整框住实物刻度尺");
      }
    }
    roiInteractionRef.current = null;
    rulerInteractionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    updateOverlayCursor(event.currentTarget, pointerPosition(event));
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    roiInteractionRef.current = null;
    rulerInteractionRef.current = null;
    rulerRegionStartRef.current = null;
    event.currentTarget.style.cursor = calibrationMode || canvasInteractionMode === "ruler-region-selection" ? "crosshair" : rulerMode ? "default" : "crosshair";
  };

  const toggleRulerFit = () => {
    if (sourceMode === "simulator") {
      setToast("标尺套合仅用于摄像头或实验图片");
      return;
    }
    if (rulerMode) {
      setRulerMode(false);
      setCanvasInteractionMode("roi");
      rulerInteractionRef.current = null;
      setToast("已取消标尺套合，空间比例未改变");
      return;
    }
    setCalibrationMode(false);
    setCalibrationPoints([]);
    setRulerFitConfidence(null);
    setRulerMode(true);
    setCanvasInteractionMode("ruler-overlay-adjustment");
    setRulerPanelOpen(true);
    if (sourceMode === "camera" && !isFrozen) setIsFrozen(true);
    setToast("已进入手动套合：拖动尺体平移，拖动两端调整长度与角度");
  };

  const startRulerRegionSelection = () => {
    if (sourceMode === "simulator") return;
    if (sourceMode === "camera" && !isFrozen) setIsFrozen(true);
    rulerDetectionRequestRef.current += 1;
    rulerWorkerRef.current?.terminate();
    rulerWorkerRef.current = null;
    setCalibrationMode(false);
    setRulerMode(false);
    setRulerRegion(null);
    setCanvasInteractionMode("ruler-region-selection");
    setRulerDetectionState("idle");
    setToast("请拖动矩形，完整框住实物刻度尺");
  };

  const smartSnapRuler = () => {
    const canvas = frameCanvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context || !rulerMode) return;
    if (rulerDetection) {
      const detectedRuler = rulerFromDetection({
        ...rulerDetection,
        manualOriginMm,
        tickSnapEnabled,
        numberSnapEnabled,
      });
      setRuler(detectedRuler);
      setRulerFitConfidence(rulerDetection.fit.confidence);
      setSnapHighlight(rulerDetection.numbers.length > 0 ? "数字锚点" : "毫米刻线");
      setToast("虚拟尺已重新吸附到稳健刻线拟合结果，请核对重合情况");
      return;
    }
    const suggestion = suggestRulerAlignment(
      context.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT),
      ruler,
    );
    if (!suggestion) {
      setRulerFitConfidence(null);
      setToast("未可靠识别刻度尺边缘，请继续手动套合");
      return;
    }
    setRuler(suggestion.ruler);
    setRulerFitConfidence(suggestion.confidence);
    setToast(`已给出吸附建议，置信度 ${(suggestion.confidence * 100).toFixed(0)}%，请人工确认`);
  };

  const applyRulerCalibration = () => {
    const pixelLength = rulerLengthPx(ruler);
    const scale = rulerMmPerPixel(ruler);
    if (scale == null || !Number.isFinite(pixelLength) || pixelLength < MIN_RULER_LENGTH_PX) {
      setToast(`标尺至少需要 ${MIN_RULER_LENGTH_PX} px，请拉开两个端点`);
      return;
    }
    if (rulerDetection && !lowConfidenceConfirmed) {
      setToast("自动周期可能识别成 5/10 mm 倍频，请核对真实区间和刻线重合后勾选确认");
      return;
    }
    const uncertainty = rulerUncertaintyPct(ruler);
    setMmPerPixel(scale);
    if (uncertainty != null) setCalibrationUncertaintyPct(uncertainty);
    setCalibrationSource("physical-ruler-overlay");
    setSpatialAnchors([]);
    setCalibrationStale(false);
    setCalibrationPoints([]);
    setRulerMode(false);
    setCanvasInteractionMode("roi");
    setRulerDetectionState("applied");
    setRulerDetection((current) => current ? {
      ...current,
      manualOriginMm,
      contrastMode: rulerContrastMode,
      theme: rulerTheme,
      tickSnapEnabled,
      numberSnapEnabled,
    } : current);
    setToast(`标尺标定已应用：${scale.toFixed(5)} mm/px`);
  };

  const setManualScale = (value: number) => {
    setMmPerPixel(value);
    setCalibrationSource("manual-scale");
    setCalibrationStale(false);
    setSpatialAnchors([]);
  };

  const startMultiPointCalibration = () => {
    if (sourceMode === "camera") setIsFrozen(true);
    setDraftAnchors(spatialAnchors);
    setAnchorReading(spatialAnchors.length ? Math.max(...spatialAnchors.map((anchor) => anchor.mm)) / (rulerUnit === "cm" ? 10 : 1) + 1 : 0);
    setCalibrationMode(false);
    setRulerMode(false);
    setCanvasInteractionMode("multi-point-calibration");
    setRulerPanelOpen(true);
  };

  const applyMultiPointCalibration = () => {
    const validation = validateSpatialAnchors(draftAnchors);
    if (!validation.valid) { setToast(validation.reason); return; }
    const sorted = [...draftAnchors].sort((a, b) => a.mm - b.mm);
    const first = sorted[0]; const last = sorted[sorted.length - 1];
    const axisAngle = Math.atan2(last.y - first.y, last.x - first.x);
    const roiAngle = (roi.angleDeg + (orientation === "horizontal" ? 90 : 0)) * Math.PI / 180;
    if (Math.abs(Math.cos(axisAngle - roiAngle)) < Math.cos(10 * Math.PI / 180)) {
      setToast("局部尺标轴与条纹变化方向不平行，请调整 ROI 角度/方向或换用两点比例标定"); return;
    }
    setMmPerPixel((last.mm - first.mm) / Math.hypot(last.x - first.x, last.y - first.y));
    setSpatialAnchors(sorted);
    setCalibrationSource("multi-point");
    setCalibrationStale(false);
    setCanvasInteractionMode("roi");
    setRulerDetectionState("applied");
    setToast(`已应用 ${sorted.length} 点局部尺标：分段插值，不是假设整个画面比例恒定`);
  };

  const runRulerOcr = async () => {
    const native = sourceCanvasRef.current;
    if (!native) return;
    if (!rulerRegion && !rulerDetection) { setToast("请先框选尺子（含数字），再识别数字"); return; }
    const requestId = rulerDetectionRequestRef.current;
    const scale = Math.min(FRAME_WIDTH / native.width, FRAME_HEIGHT / native.height);
    const offsetX = (FRAME_WIDTH - native.width * scale) / 2;
    const offsetY = (FRAME_HEIGHT - native.height * scale) / 2;
    const region = rulerRegion ?? rulerDetection!.selectedRegion;
    const nativeRegion = { x: (region.x - offsetX) / scale, y: (region.y - offsetY) / scale, width: region.width / scale, height: region.height / scale };
    const toNative = (point: Point) => ({ x: (point.x - offsetX) / scale, y: (point.y - offsetY) / scale });
    const detection = rulerDetection ? { ...rulerDetection, start: toNative(rulerDetection.start), ticks: rulerDetection.ticks.map((tick) => ({ ...tick, point: toNative(tick.point) })), fit: { ...rulerDetection.fit, pixelsPerMm: rulerDetection.fit.pixelsPerMm / scale } } : null;
    setOcrBusy(true); setOcrMessage("正在下载/载入本地 OCR 模型并识别数字；图片不会上传。");
    try {
      const result = await recognizeRulerReadings(native, nativeRegion, rulerUnit, detection);
      if (requestId !== rulerDetectionRequestRef.current) return;
      const anchors = result.anchors.map((anchor) => ({ x: anchor.x * scale + offsetX, y: anchor.y * scale + offsetY, mm: anchor.mm }));
      setRulerDetection((current) => current ? { ...current, numbers: result.numbers.map((number) => ({ ...number, point: { x: number.point.x * scale + offsetX, y: number.point.y * scale + offsetY }, axisPositionPx: number.axisPositionPx * scale })), ocrStatus: result.numbers.length >= 3 ? "recognized" : result.numbers.length ? "partial" : "not-found" } : current);
      const validation = validateSpatialAnchors(anchors);
      if (validation.valid && validation.variationPct < 30) {
        setDraftAnchors(anchors); setRulerMode(false); setCalibrationMode(false); setCanvasInteractionMode("multi-point-calibration");
        setOcrMessage(`识别读数 ${result.numbers.map((number) => number.text).join("、")}（${rulerUnit}）。已生成 ${anchors.length} 个候选尺标；请逐个核对数字、单位和刻线位置后应用。`);
      } else {
        setOcrMessage(`数字候选：${result.numbers.map((number) => number.text).join("、") || "无"}。未形成可靠刻线对应，请框选更清晰数字区域或使用多点手动标定；未更改比例。`);
      }
    } catch {
      setOcrMessage("OCR 模型载入或识别失败；请检查网络，或使用多点手动标定。原比例未改变。");
    } finally { setOcrBusy(false); }
  };

  const exportCsv = () => {
    if (!analysis) return;
    const csv = rowsToCsv(
      ["index", "position_px", "position_mm", "raw_dn", "corrected_au", "smoothed_au", "model_normalized"],
      analysis.raw.map((value, index) => [
        index,
        analysis.axisPx[index],
        analysis.measurementReady ? analysis.axisMm[index] : null,
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
          schema: "fringelab.measurement.v3",
          createdAt: new Date().toISOString(),
          terminology: "Relative intensity (camera response, arbitrary units); not lux.",
          configuration: {
            sourceMode,
            experiment,
            channel,
            orientation,
            roi,
            mmPerPixel,
            spatialCalibration: {
              calibrationMethod: calibrationSource,
              stale: calibrationStale,
              spatialAnchors,
              localScaleVariationPct: validateSpatialAnchors(spatialAnchors).variationPct,
              ruler,
              fitConfidence: rulerFitConfidence,
              interactionMode: canvasInteractionMode,
              rulerDetection,
              manualAdjustments: {
                contrastMode: rulerContrastMode,
                manualOriginMm,
                tickSnapEnabled,
                numberSnapEnabled,
              },
            },
            screenDistanceM,
            slitWidthMm: config.slitWidthKnown ? slitWidthMm : null,
            slitSeparationMm,
            referenceWavelengthNm: sourceMode === "simulator" || hasReference ? referenceWavelengthNm : null,
            parametersConfirmed,
            slitWidthKnown,
            sourceResolution,
            sourceFilename,
            captureSettings,
            inputUncertainty: { apertureUncertaintyMm, distanceUncertaintyM, calibrationUncertaintyPct, coverageFactor: 1.96, excludes: ["ISP nonlinearity", "unknown optical geometry", "ruler/screen depth mismatch"] },
            showModelFit,
          },
          result: analysis.measurementReady ? analysis : { ...analysis, axisMm: null, centralPositionMm: null, peaks: analysis.peaks.map((mark) => ({ ...mark, positionMm: null })), troughs: analysis.troughs.map((mark) => ({ ...mark, positionMm: null })) },
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
      calibrationSource,
      calibrationStale,
      spatialAnchors, hasReference, slitWidthKnown, parametersConfirmed,
      ruler,
      rulerFitConfidence,
      rulerDetection,
      rulerDetectionState,
      rulerContrastMode,
      tickSnapEnabled,
      numberSnapEnabled,
      manualOriginMm,
      twoPointDistanceMm,
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
      if (typeof value.hasReference === "boolean") setHasReference(value.hasReference);
      if (typeof value.slitWidthKnown === "boolean") setSlitWidthKnown(value.slitWidthKnown);
      setParametersConfirmed(false);
      setSpatialAnchors([]);
      if (typeof value.apertureUncertaintyMm === "number") setApertureUncertaintyMm(value.apertureUncertaintyMm);
      if (typeof value.distanceUncertaintyM === "number") setDistanceUncertaintyM(value.distanceUncertaintyM);
      if (typeof value.calibrationUncertaintyPct === "number") setCalibrationUncertaintyPct(value.calibrationUncertaintyPct);
      if (typeof value.smoothingSigma === "number") setSmoothingSigma(value.smoothingSigma);
      if (typeof value.showModelFit === "boolean") setShowModelFit(value.showModelFit);
      const restoredCalibrationSource: SpatialCalibrationSource = value.calibrationSource === "two-point"
        ? "two-point"
        : value.calibrationSource === "ruler-fit" || value.calibrationSource === "physical-ruler-overlay"
          ? "physical-ruler-overlay"
          : value.calibrationSource === "physical-ruler-perspective"
            ? "physical-ruler-perspective"
            : "manual-scale";
      setCalibrationSource(restoredCalibrationSource);
      const physicalRulerCalibration = restoredCalibrationSource === "physical-ruler-overlay" ||
        restoredCalibrationSource === "physical-ruler-perspective";
      setCalibrationStale(true);
      if (physicalRulerCalibration) setRulerDetectionState("stale");
      if (typeof value.rulerFitConfidence === "number") setRulerFitConfidence(value.rulerFitConfidence);
      if (typeof value.twoPointDistanceMm === "number" && value.twoPointDistanceMm > 0) setTwoPointDistanceMm(value.twoPointDistanceMm);
      if (typeof value.manualOriginMm === "number") setManualOriginMm(value.manualOriginMm);
      if (typeof value.tickSnapEnabled === "boolean") setTickSnapEnabled(value.tickSnapEnabled);
      if (typeof value.numberSnapEnabled === "boolean") setNumberSnapEnabled(value.numberSnapEnabled);
      if (["auto", "light-on-dark", "dark-on-light", "cyan", "magenta"].includes(String(value.rulerContrastMode))) {
        setRulerContrastMode(value.rulerContrastMode as RulerContrastMode);
      }
      if (value.rulerDetection && typeof value.rulerDetection === "object") {
        const candidate = value.rulerDetection as Partial<RulerDetectionResult>;
        if (candidate.schema === "fringelab.ruler-detection.v1" && candidate.fit && Array.isArray(candidate.ticks)) {
          setRulerDetection(candidate as RulerDetectionResult);
        }
      }
      if (value.ruler && typeof value.ruler === "object") {
        const candidate = value.ruler as Partial<RulerCalibration>;
        if (
          candidate.start && candidate.end &&
          Number.isFinite(candidate.start.x) && Number.isFinite(candidate.start.y) &&
          Number.isFinite(candidate.end.x) && Number.isFinite(candidate.end.y) &&
          Number.isFinite(candidate.knownLengthMm) && Number(candidate.knownLengthMm) > 0
        ) {
          setRuler(candidate as RulerCalibration);
        }
      }
      if (value.roi && typeof value.roi === "object") setRoi(value.roi as Roi);
      if (["auto", "r", "g", "b", "luminance"].includes(String(value.channel))) {
        setChannel(value.channel as RequestedProfileChannel);
      }
      if (value.orientation === "vertical" || value.orientation === "horizontal") {
        setOrientation(value.orientation);
      }
      setCanvasInteractionMode("roi");
      setToast(physicalRulerCalibration
        ? "已恢复参数；原图片未随会话保存，实物标尺标定已标记为 STALE"
        : "已恢复本机实验参数");
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
    setCalibrationSource("manual-scale");
    setCalibrationStale(false);
    setRulerMode(false);
    setRuler(DEFAULT_RULER);
    setRulerFitConfidence(null);
    setRulerDetection(null);
    setRulerDetectionState("idle");
    setCanvasInteractionMode("roi");
    setImageLoaded(false);
    setScreenDistanceM(1.5);
    setSlitWidthMm(mode === "double" ? 0.04 : 0.12);
    setSlitSeparationMm(0.25);
    setRoi(DEFAULT_ROI);
    setBackground(null);
    setSpatialAnchors([]);
    setDraftAnchors([]);
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
    : sourceMode === "simulator" ? "960×540" : sourceResolution;
  const hasManualExposure = Boolean(cameraSnapshot?.capabilities.exposureMode?.includes("manual"));
  const calibrationSourceLabel = calibrationStale
    ? "STALE"
    : calibrationSource === "physical-ruler-perspective"
      ? "RULER H"
      : calibrationSource === "multi-point" ? "LOCAL SCALE" : calibrationSource === "physical-ruler-overlay" ? "RULER FIT" : calibrationSource === "two-point" ? "2-POINT" : "MANUAL";
  const currentRulerLengthPx = rulerLengthPx(ruler);
  const currentRulerScale = rulerMmPerPixel(ruler);
  const rulerCanApply = Number.isFinite(currentRulerLengthPx) &&
    currentRulerLengthPx >= MIN_RULER_LENGTH_PX && currentRulerScale != null &&
    (!rulerDetection || lowConfidenceConfirmed);
  const rulerSourceReady = !imageLoading && (sourceMode === "image"
    ? imageLoaded
    : sourceMode === "camera" ? cameraSnapshot != null : false);
  const rulerDetectionStatusLabel = calibrationStale || rulerDetectionState === "stale"
    ? "已失效"
    : rulerDetectionState === "detecting" ? "识别中"
      : rulerDetectionState === "candidate" ? "待确认"
        : rulerDetectionState === "applied" ? "已应用"
          : rulerDetectionState === "failed" ? "未识别" : "未识别";

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
                <button
                  className={`source-tab upload-button ${sourceMode === "image" ? "active" : ""}`}
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-controls="image-file-input"
                >
                    {imageLoading ? "解码中…" : "图片"}
                </button>
                <input
                  ref={fileInputRef}
                  id="image-file-input"
                  className="source-file-input"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.HEIC,.heif"
                  onChange={handleImageUpload}
                  tabIndex={-1}
                />
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
                  <div className="micro-card-value"><span>{formatNumber(mmPerPixel, 5)} mm/px</span><span>{calibrationSourceLabel}</span></div>
                </div>
                <div className="micro-card">
                  <div className="micro-card-label">SIGNAL RANGE</div>
                  <div className="micro-card-value"><span>{formatNumber(analysis?.dynamicRange ?? null, 1)} DN</span><span>SAT {formatNumber((analysis?.saturationRate ?? 0) * 100, 2)}%</span></div>
                </div>
              </div>
              {sourceMode !== "simulator" ? (
                <section className="real-setup" aria-label="实测参数">
                  <div className="control-title-row"><h3>实测流程</h3><span className="control-index">d / L → 尺标 → 结果</span></div>
                  <div className="field-grid">
                    <FieldNumber label={experiment === "double" ? "双缝中心距 d" : "单缝宽度 a"} value={experiment === "double" ? slitSeparationMm : slitWidthMm} unit="mm" min={0.001} step={0.001} onChange={(value) => { if (experiment === "double") setSlitSeparationMm(value); else setSlitWidthMm(value); setParametersConfirmed(false); }} />
                    <FieldNumber label="缝到屏距离 L" value={screenDistanceM} unit="m" min={0.01} step={0.001} onChange={(value) => { setScreenDistanceM(value); setParametersConfirmed(false); }} />
                  </div>
                  <div className="button-row space-top-sm">
                    <button type="button" className={`button ${parametersConfirmed ? "" : "primary"}`} onClick={() => setParametersConfirmed(true)} disabled={!(screenDistanceM > 0 && (experiment === "double" ? slitSeparationMm : slitWidthMm) > 0)}>{parametersConfirmed ? "参数已确认" : "确认实测参数"}</button>
                    <span className="ruler-footnote">{parametersConfirmed ? "已使用你填写的器材数据。" : "默认值不是实测值，请填写并确认。"} {calibrationStale ? "当前尺标待标定。" : "当前尺标有效。"}</span>
                  </div>
                  <div className="ruler-footnote">载入或拍摄条纹与同平面的真实尺 → 选取不含尺子的条纹 ROI → 完成尺标。摄像头移动、变焦或改变分辨率后请重新标定。原图分析：{sourceResolution}。</div>
                </section>
              ) : null}
              <details
                className={`ruler-fit-panel ${rulerDetectionState}`}
                open={sourceMode !== "simulator" && rulerPanelOpen}
                onToggle={(event) => setRulerPanelOpen(event.currentTarget.open)}
              >
                <summary>
                  <span><strong>标尺套合</strong><small>RULER FIT / LOCAL SCALE</small></span>
                  <span className={`ruler-state ${rulerDetectionState}`}>{sourceMode === "simulator" ? "无需标定" : rulerDetectionStatusLabel}</span>
                </summary>
                <div className="ruler-fit-body">
                    {sourceMode === "simulator"
                      ? <div className="notice">仿真图样已有已知空间比例，无需实物标尺标定。</div>
                      : !rulerSourceReady ? <div className="notice warn">请先连接摄像头或载入实验图片，之后才能识别实物刻度尺。</div> : null}
                    <div className="button-row">
                      <button
                        type="button"
                        className="button primary"
                        disabled={!rulerSourceReady || rulerDetectionState === "detecting"}
                        onClick={() => runPhysicalRulerDetection()}
                        title="Detect Physical Ruler"
                      >
                        自动识别刻度尺
                      </button>
                      <button type="button" className="button" disabled={!rulerSourceReady || rulerDetectionState === "detecting"} onClick={startRulerRegionSelection} title="Select Ruler Region">框选实物尺</button>
                      <button type="button" className={`button ${rulerMode && !rulerDetection ? "warn" : ""}`} disabled={!rulerSourceReady || rulerDetectionState === "detecting"} onClick={toggleRulerFit}>手动套合</button>
                      <button type="button" className="button" disabled={!rulerSourceReady || rulerDetectionState === "detecting"} onClick={startMultiPointCalibration}>多点局部标定</button>
                      <button type="button" className="button" disabled={!rulerSourceReady || ocrBusy || rulerDetectionState === "detecting"} onClick={runRulerOcr}>{ocrBusy ? "OCR 识别中…" : "识别尺上数字（OCR）"}</button>
                      {rulerDetectionState === "detecting" ? <button type="button" className="button danger" onClick={cancelRulerDetection}>取消识别</button> : null}
                    </div>
                    <div className="ruler-options">
                      <label><span>真实尺数字单位</span><select value={rulerUnit} onChange={(event) => setRulerUnit(event.currentTarget.value as "cm" | "mm")}><option value="cm">cm（数字 1 = 10 mm）</option><option value="mm">mm（数字 1 = 1 mm）</option></select></label>
                    </div>
                    {ocrMessage ? <div className="notice warn" role="status">{ocrMessage}</div> : null}
                    {canvasInteractionMode === "multi-point-calibration" ? (
                      <div className="local-calibration">
                        <FieldNumber label="下一点真实读数" value={anchorReading} unit={rulerUnit} step={rulerUnit === "cm" ? 1 : 10} onChange={setAnchorReading} />
                        <div className="notice space-top-sm">请点击该读数对应的刻线（不是数字中心），至少 3 点，建议覆盖整个条纹区。可跳过遮挡的刻线并修改下一读数。尺轴应与条纹变化方向平行；只校正该方向的局部比例，不是完整二维透视矫正。</div>
                        <div className="anchor-list">{draftAnchors.map((anchor, index) => <button className="button" type="button" key={`${anchor.mm}-${index}`} title="点击删除此尺标点" onClick={() => setDraftAnchors((current) => current.filter((_, i) => i !== index))}>{anchor.mm} mm ×</button>)}</div>
                        <div className="ruler-footnote">{validateSpatialAnchors(draftAnchors).reason} · 局部比例变化 {formatNumber(validateSpatialAnchors(draftAnchors).variationPct, 2)}%</div>
                        <div className="button-row space-top-sm">
                          <button type="button" className="button primary" disabled={!validateSpatialAnchors(draftAnchors).valid} onClick={applyMultiPointCalibration}>核对并应用局部尺标</button>
                          <button type="button" className="button" onClick={() => setDraftAnchors([])}>清空候选点</button>
                          <button type="button" className="button" onClick={() => setCanvasInteractionMode("roi")}>取消编辑</button>
                        </div>
                      </div>
                    ) : spatialAnchors.length ? <div className="notice">已应用 {spatialAnchors.length} 点局部尺标，比例变化 {formatNumber(validateSpatialAnchors(spatialAnchors).variationPct, 2)}%。位置在尺标范围内分段插值；超出范围的测量不建议使用。</div> : null}
                    {rulerDetectionState === "detecting" ? (
                      <div className="ruler-progress" role="status" aria-live="polite">
                        <span style={{ width: `${rulerDetectionProgress}%` }} />
                        <small>正在本机分析尺体方向、边缘和毫米刻线… {rulerDetectionProgress}%</small>
                      </div>
                    ) : null}
                    <div className="ruler-options">
                      <label>
                        <span>显示模式</span>
                        <select value={rulerContrastMode} onChange={(event) => setRulerContrastMode(event.currentTarget.value as RulerContrastMode)}>
                          <option value="auto">自动对比</option>
                          <option value="dark-on-light">深色刻线</option>
                          <option value="light-on-dark">浅色刻线</option>
                          <option value="cyan">青色</option>
                          <option value="magenta">品红色</option>
                        </select>
                      </label>
                      <label className="check-option"><input type="checkbox" checked={tickSnapEnabled} onChange={(event) => setTickSnapEnabled(event.currentTarget.checked)} />刻线磁吸</label>
                      <label className="check-option"><input type="checkbox" checked={numberSnapEnabled} onChange={(event) => setNumberSnapEnabled(event.currentTarget.checked)} />数字磁吸</label>
                    </div>
                    <div className="ruler-manual-grid">
                      <label>
                        <span>虚拟尺实际区间</span>
                        <span className="compact-number"><input type="number" min="0.001" step="0.1" value={ruler.knownLengthMm} onChange={(event) => { const value = Math.max(0.001, Number(event.currentTarget.value)); setRuler((current) => ({ ...current, knownLengthMm: value })); }} /><em>mm</em></span>
                      </label>
                      <label>
                        <span>起始刻度（OCR 回退）</span>
                        <span className="compact-number"><input type="number" step="1" value={manualOriginMm} onChange={(event) => { const value = Number(event.currentTarget.value); setManualOriginMm(value); setRuler((current) => ({ ...current, originMm: value })); }} /><em>mm</em></span>
                      </label>
                    </div>
                    {(rulerDetection || rulerMode) ? (
                      <div className="ruler-console" aria-label="毫米标尺套合控制">
                        <div className="ruler-readout">
                          <span><small>实物区间</small>{ruler.knownLengthMm.toFixed(1)} mm</span>
                          <span><small>像素长度</small>{currentRulerLengthPx.toFixed(1)} px</span>
                          <span><small>空间比例</small>{currentRulerScale?.toFixed(5) ?? "—"} mm/px</span>
                          <span><small>尺体角度</small>{rulerAngleDeg(ruler).toFixed(1)}°</span>
                          <span><small>有效刻线</small>{rulerDetection ? `${rulerDetection.fit.inlierCount} / ${rulerDetection.fit.totalCount}` : "手动"}</span>
                          <span><small>平均残差</small>{rulerDetection ? `${rulerDetection.fit.residualRmsPx.toFixed(2)} px` : "—"}</span>
                          <span><small>OCR 数字</small>{rulerDetection?.numbers.length ? rulerDetection.numbers.map((item) => item.text).join(" ") : "未确认"}</span>
                          <span><small>识别一致性（非精度）</small>{rulerFitConfidence != null ? `${(rulerFitConfidence * 100).toFixed(0)}%` : "手动"}</span>
                        </div>
                        {rulerDetection ? <div className="ruler-confidence">{rulerDetection.message}</div> : null}
                        {rulerDetection?.perspectiveWarning ? <div className="notice warn">{rulerDetection.perspectiveWarning}</div> : null}
                        {rulerDetection ? (
                          <label className="check-option low-confidence"><input type="checkbox" checked={lowConfidenceConfirmed} onChange={(event) => setLowConfidenceConfirmed(event.currentTarget.checked)} />我已核对真实区间/单位和刻线重合（排除 5 或 10 倍误判），允许应用</label>
                        ) : null}
                        <div className="button-row">
                          <button type="button" className="button" disabled={!rulerDetection} onClick={() => runPhysicalRulerDetection(rulerDetection?.selectedRegion)}>重新识别</button>
                          <button type="button" className="button" disabled={!rulerMode} onClick={smartSnapRuler}>重新吸附</button>
                          <button type="button" className="button" onClick={cancelRulerDetection}>取消</button>
                          <button type="button" className="button primary" disabled={!rulerCanApply} onClick={applyRulerCalibration}>应用标定</button>
                        </div>
                      </div>
                    ) : null}
                    <div className="ruler-footnote">刻线周期决定比例；数字只用于确认绝对起点。按住 Alt/Option 可临时关闭磁吸。刻度尺应与光屏同平面。</div>
                </div>
              </details>
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
                  <div className="metric-label">{analysis?.provisional && analysis.measurementReady ? "波长暂估 λ（需复测）" : "测量波长 λ"}</div>
                  <div className="metric-value">{formatNumber(analysis?.wavelengthNm ?? null, 1)}<em>nm</em></div>
                  <div className="metric-note">{analysis?.provisional ? "过曝：不提供完整不确定度结论" : `输入误差估算（k≈1.96）± ${formatNumber(analysis?.uncertaintyNm ?? null, 1)} nm`}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">{experiment === "double" ? "条纹间距 Δx" : "中央主极大 W₀"}</div>
                  <div className="metric-value">{formatNumber(measureValue ?? null, 3)}<em>mm</em></div>
                  <div className="metric-note">{experiment === "double" ? `${analysis?.peaks.length ?? 0} 个亮峰` : `FWHM ${formatNumber(analysis?.fwhmMm ?? null, 3)} mm`}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">参考值偏差</div>
                  <div className="metric-value">{formatNumber(analysis?.referenceErrorPct ?? null, 2)}<em>%</em></div>
                  <div className="metric-note">{sourceMode === "simulator" || hasReference ? `参考 ${formatNumber(referenceWavelengthNm, 0)} nm` : "未提供已知参考波长"} · R² {formatNumber(analysis?.regressionR2 ?? null, 4)}</div>
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
                        disabled={!config.slitWidthKnown || !analysis?.measurementReady}
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
                <div className="axis-caption"><span>归一化相机响应（a.u.，峰值≤98%）</span><span>{analysis?.measurementReady ? "屏面位置 / mm" : "待标定位置 / 原图 px"}</span></div>
              </div>
              {analysis?.warnings.map((warning) => <div className="notice warn space-top-xs" key={warning}>{warning}</div>)}
              {analysis ? <div className="ruler-footnote">{analysis.channelReason}。峰位采用颜色对比辅助定位；相机 DN 不是 lux，也不是绝对辐照度。</div> : null}

              <div className="quality-card">
                <div className="quality-header"><span>测量质量门控</span><span>{[saturationLevel, samplingLevel, fresnelLevel].every((level) => level === "good") ? "PASS" : "CHECK"}</span></div>
                <div className="quality-list">
                  <QualityItem label="饱和像素" value={`${formatNumber((analysis?.saturationRate ?? 0) * 100, 2)}%`} level={saturationLevel} />
                  <QualityItem label="条纹采样" value={`${formatNumber(samplingPixels, 1)} px`} level={samplingLevel} />
                  <QualityItem label="Fraunhofer 数" value={formatNumber(analysis?.fresnelNumber ?? null, 4)} level={fresnelLevel} />
                  <QualityItem label="空间标定" value={calibrationStale ? "需重新标定" : calibrationSource === "multi-point" ? `${spatialAnchors.length} 点局部尺标` : `${formatNumber(mmPerPixel, 5)} mm/px`} level={calibrationStale ? "warn" : mmPerPixel > 0 ? "good" : "danger"} />
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
              <button type="button" className={`segment-button ${experiment === "double" ? "active" : ""}`} onClick={() => { setExperiment("double"); setParametersConfirmed(false); }}>双缝干涉</button>
              <button type="button" className={`segment-button ${experiment === "single" ? "active" : ""}`} onClick={() => { setExperiment("single"); setParametersConfirmed(false); }}>单缝衍射</button>
            </div>
            <div className="divider" />
            <div className="field-grid">
              {sourceMode === "simulator" ? <>
                <FieldNumber label="缝宽 a" value={slitWidthMm} unit="mm" min={0.001} step={0.001} onChange={setSlitWidthMm} />
                {experiment === "double" ? <FieldNumber label="双缝中心距 d" value={slitSeparationMm} unit="mm" min={0.002} step={0.001} onChange={setSlitSeparationMm} /> : null}
                <FieldNumber label="缝到屏距离 L" value={screenDistanceM} unit="m" min={0.01} step={0.01} onChange={setScreenDistanceM} />
                <FieldNumber label="仿真波长" value={referenceWavelengthNm} unit="nm" min={300} max={1000} step={1} onChange={setReferenceWavelengthNm} />
              </> : <>
                <label className="check-option"><input type="checkbox" checked={hasReference} onChange={(event) => setHasReference(event.currentTarget.checked)} />有已知参考波长（可选）</label>
                {hasReference ? <FieldNumber label="已知参考波长（非实测结果）" value={referenceWavelengthNm} unit="nm" min={300} max={1000} step={1} onChange={setReferenceWavelengthNm} /> : null}
                {experiment === "double" ? <label className="check-option"><input type="checkbox" checked={slitWidthKnown} onChange={(event) => setSlitWidthKnown(event.currentTarget.checked)} />已知单缝宽 a（仅包络模型需要）</label> : null}
                {experiment === "double" && slitWidthKnown ? <FieldNumber label="包络模型缝宽 a（可选）" value={slitWidthMm} unit="mm" min={0.001} step={0.001} onChange={setSlitWidthMm} /> : null}
              </>}
              <FieldNumber label={experiment === "double" ? "d 标准不确定度（估计）" : "a 标准不确定度（估计）"} value={apertureUncertaintyMm} unit="mm" min={0} step={0.001} onChange={setApertureUncertaintyMm} />
              <FieldNumber label="L 标准不确定度" value={distanceUncertaintyM} unit="m" min={0} step={0.001} onChange={setDistanceUncertaintyM} />
            </div>
            <div className="ruler-footnote">双缝测波长只要求 d、L 和尺标。包络模型另需 a；参考波长仅作比较，不自动假设 650 nm。输入误差估算未包含相机非线性、透视和屏面不共面等系统误差。</div>
            {sourceMode === "simulator" ? <>
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
            </> : null}
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
                <input id="roi-length" type="range" min={ROI_MIN_WIDTH} max={ROI_MAX_WIDTH} step={1} value={roi.width} onChange={(event) => { const width = Number(event.currentTarget.value); setRoi((current) => ({ ...current, width })); setBackground(null); }} />
              </div>
              <div className="field full">
                <label htmlFor="roi-thickness">ROI 厚度 · {Math.round(roi.height)} px（沿条纹平均）</label>
                <input id="roi-thickness" type="range" min={ROI_MIN_HEIGHT} max={ROI_MAX_HEIGHT} step={1} value={roi.height} onChange={(event) => { const height = Number(event.currentTarget.value); setRoi((current) => ({ ...current, height })); setBackground(null); }} />
              </div>
              <div className="field full">
                <label htmlFor="roi-angle">ROI 角度 · {roi.angleDeg.toFixed(1)}°</label>
                <input id="roi-angle" type="range" min={-30} max={30} step={0.1} value={roi.angleDeg} onChange={(event) => { const angleDeg = Number(event.currentTarget.value); setRoi((current) => ({ ...current, angleDeg })); setBackground(null); }} />
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
                <select id="profile-channel" value={channel} onChange={(event) => { setChannel(event.currentTarget.value as RequestedProfileChannel); setBackground(null); }}>
                  <option value="auto">自动最佳通道</option>
                  <option value="r">R 红通道</option>
                  <option value="g">G 绿通道</option>
                  <option value="b">B 蓝通道</option>
                  <option value="luminance">亮度 Y</option>
                </select>
              </div>
              <FieldNumber label="空间比例" value={mmPerPixel} unit="mm/px" min={0.00001} step={0.00001} onChange={setManualScale} />
              <FieldNumber
                label="两点实际距离"
                value={twoPointDistanceMm}
                unit="mm"
                min={0.001}
                step={0.1}
                onChange={setTwoPointDistanceMm}
              />
              <FieldNumber label="标定相对不确定度" value={calibrationUncertaintyPct} unit="%" min={0} step={0.1} onChange={setCalibrationUncertaintyPct} />
              <FieldNumber label="高斯平滑 σ" value={smoothingSigma} unit="px" min={0} max={10} step={0.1} onChange={setSmoothingSigma} />
            </div>
            <div className="button-row space-top-md">
              <button type="button" className={`button ${calibrationMode ? "warn" : ""}`} onClick={() => {
                const next = !calibrationMode;
                setRulerMode(false);
                setCalibrationMode(next);
                setCanvasInteractionMode(next ? "two-point-calibration" : "roi");
                setCalibrationPoints([]);
              }}>
                {calibrationMode ? "取消标定" : "两点标定"}
              </button>
              <button type="button" className="button" onClick={() => setRoi(DEFAULT_ROI)}>重置 ROI</button>
              <button type="button" className="button" onClick={freezeCurrentFrame}>冻结当前帧</button>
            </div>
            <div className={`notice space-top-sm ${calibrationMode || rulerMode || calibrationStale ? "warn" : ""}`}>
              {rulerMode
                ? "标尺套合正在光学画面下方的 RULER FIT 面板中进行。"
                : calibrationMode
                  ? `两点标定：请在画面上依次点击两点，实际距离设为 ${twoPointDistanceMm} mm。`
                  : calibrationStale
                    ? "输入源已经变化，原实物标尺比例已失效；请在光学画面的 RULER FIT 中重新识别，或使用手动/两点标定。"
                    : sourceMode === "simulator"
                      ? "拖动 ROI 内部改变位置；拖动四角方块调整长宽。仿真使用已知空间比例。"
                      : "这里保留 ROI、手动比例和两点标定；实物标尺套合位于左上光学画面下方。"}
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
                      <td>{analysis?.measurementReady ? formatNumber(mark.positionMm, 4) : "待标定"}</td>
                      <td>{mark.saturated ? "过曝无效" : formatNumber(mark.value, 2)}</td>
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
