/// <reference lib="webworker" />

import { detectPhysicalRuler, type RulerContrastMode, type RulerRegion } from "./ruler-detection";

type DetectMessage = {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  sourceType: "camera" | "image";
  region?: RulerRegion;
  contrastMode: RulerContrastMode;
  tickSnapEnabled: boolean;
  numberSnapEnabled: boolean;
  manualOriginMm: number | null;
};

self.onmessage = (event: MessageEvent<DetectMessage>) => {
  const message = event.data;
  try {
    const result = detectPhysicalRuler(
      {
        width: message.width,
        height: message.height,
        data: new Uint8ClampedArray(message.buffer),
      },
      {
        sourceType: message.sourceType,
        region: message.region,
        contrastMode: message.contrastMode,
        tickSnapEnabled: message.tickSnapEnabled,
        numberSnapEnabled: message.numberSnapEnabled,
        manualOriginMm: message.manualOriginMm,
      },
    );
    self.postMessage({ id: message.id, result });
  } catch (error) {
    self.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : "刻度尺识别失败",
    });
  }
};

export {};
