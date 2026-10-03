import type { DetectedRulerNumber, RulerDetectionResult, RulerRegion } from "./ruler-detection";
import type { SpatialAnchor } from "./spatial";

/** OCR is an assistive candidate generator. The user must verify tick alignment. */
export async function recognizeRulerReadings(
  source: HTMLCanvasElement,
  region: RulerRegion,
  unit: "cm" | "mm",
  detection: RulerDetectionResult | null,
): Promise<{ anchors: SpatialAnchor[]; numbers: DetectedRulerNumber[] }> {
  const crop = document.createElement("canvas");
  const zoom = Math.min(3, 2600 / region.width);
  crop.width = Math.max(1, Math.round(region.width * zoom));
  crop.height = Math.max(1, Math.round(region.height * zoom));
  const context = crop.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法读取数字区域");
  context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, crop.width, crop.height);
  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    await worker.setParameters({ tessedit_char_whitelist: "0123456789.", tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    const result = await worker.recognize(crop, {}, { blocks: true });
    const words = result.data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words))) ?? [];
    const candidates = words.filter((word) => /^\d{1,3}(\.\d)?$/.test(word.text.trim()) && word.confidence >= 45).map((word) => ({
      text: word.text.trim(), value: Number(word.text.trim()) * (unit === "cm" ? 10 : 1),
      point: { x: region.x + (word.bbox.x0 + word.bbox.x1) / 2 / zoom, y: region.y + (word.bbox.y0 + word.bbox.y1) / 2 / zoom },
      confidence: word.confidence / 100,
      glyphHeight: (word.bbox.y1 - word.bbox.y0) / zoom,
    }));
    const radians = (detection?.angleDeg ?? 0) * Math.PI / 180;
    const axis = { x: Math.cos(radians), y: Math.sin(radians) };
    const start = detection?.start ?? { x: region.x, y: region.y };
    // Ignore serial numbers / certification text on another row of the ruler.
    // Keep the largest number row rather than treating every digit as a scale.
    const normalPosition = (candidate: typeof candidates[number]) => -(candidate.point.x - start.x) * axis.y + (candidate.point.y - start.y) * axis.x;
    const rowCandidates = candidates.map((candidate) => candidates.filter((other) => Math.abs(normalPosition(other) - normalPosition(candidate)) <= Math.max(candidate.glyphHeight, other.glyphHeight) * .65));
    const strongestRow = rowCandidates.reduce<typeof candidates>((best, row) => row.length > best.length ? row : best, []);
    const sorted = strongestRow.sort((a, b) => (a.point.x - b.point.x) * axis.x + (a.point.y - b.point.y) * axis.y);
    const unique = sorted.filter((candidate, index) => sorted.findIndex((item) => item.value === candidate.value) === index);
    const numbers: DetectedRulerNumber[] = unique.map((candidate) => {
      const nearest = detection?.ticks.reduce<typeof detection.ticks[number] | null>((best, tick) => {
        const distance = (point: { x: number; y: number }) => Math.abs((point.x - candidate.point.x) * axis.x + (point.y - candidate.point.y) * axis.y);
        return !best || distance(tick.point) < distance(best.point) ? tick : best;
      }, null);
      const distance = nearest ? Math.abs((nearest.point.x - candidate.point.x) * axis.x + (nearest.point.y - candidate.point.y) * axis.y) : Infinity;
      const matched = nearest && distance <= (detection?.fit.pixelsPerMm ?? 1) * 2;
      return { ...candidate, axisPositionPx: (candidate.point.x - start.x) * axis.x + (candidate.point.y - start.y) * axis.y, associatedMillimetreIndex: matched ? nearest.millimetreIndex : null, point: matched ? nearest.point : candidate.point };
    });
    // A number's centre is not a scale tick. Only matched tick coordinates may
    // become calibration anchors, and they remain un-applied draft candidates.
    const anchors = numbers.filter((number) => number.associatedMillimetreIndex != null).map((number) => ({ ...number.point, mm: number.value }));
    return { anchors, numbers };
  } finally { await worker.terminate(); }
}
