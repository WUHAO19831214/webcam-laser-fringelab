import type { ImageDataLike } from "./signal";
import type { RoiGeometry } from "./roi";

/** Position-only colour-excess heuristic; never edits the original pixel data. */
export function suggestFringeRoi(image: ImageDataLike, displayWidth = 960, displayHeight = 540): RoiGeometry | null {
  const step = Math.max(1, Math.ceil(Math.max(image.width, image.height) / 900));
  const rows: number[] = [];
  const excess = (x: number, y: number) => {
    const i = (y * image.width + x) * 4;
    const rgb = [Number(image.data[i]), Number(image.data[i + 1]), Number(image.data[i + 2])];
    const maximum = Math.max(...rgb);
    return Math.max(0, maximum - (rgb.reduce((a, b) => a + b, 0) - maximum) / 2 - 25);
  };
  for (let y = 0; y < image.height; y += step) {
    let score = 0;
    for (let x = 0; x < image.width; x += step) score += excess(x, y);
    rows.push(score);
  }
  const scale = Math.min(displayWidth / image.width, displayHeight / image.height);
  const halfBand = Math.max(1, Math.round(12 / scale / step));
  let best = 0; let bestScore = 0;
  for (let y = halfBand; y < rows.length - halfBand; y++) {
    let score = 0;
    for (let j = y - halfBand; j <= y + halfBand; j++) score += rows[j];
    if (score > bestScore) { bestScore = score; best = y; }
  }
  if (bestScore < 100) return null;
  const support: number[] = [];
  const y = Math.min(image.height - 1, best * step);
  for (let x = 0; x < image.width; x += step) if (excess(x, y) >= 12) support.push(x);
  if (support.length < 10) return null;
  const left = support[Math.floor(support.length * .01)];
  const right = support[Math.floor(support.length * .99)];
  return { centerX: (displayWidth - image.width * scale) / 2 + (left + right) * scale / 2, centerY: (displayHeight - image.height * scale) / 2 + y * scale, width: Math.max(80, Math.min(930, (right - left) * scale + 30)), height: 24, angleDeg: 0 };
}
