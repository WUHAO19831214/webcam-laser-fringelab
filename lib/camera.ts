export type ExtendedCameraCapabilities = MediaTrackCapabilities & {
  exposureMode?: string[];
  exposureTime?: { min: number; max: number; step: number };
  exposureCompensation?: { min: number; max: number; step: number };
  iso?: { min: number; max: number; step: number };
  focusMode?: string[];
  focusDistance?: { min: number; max: number; step: number };
  whiteBalanceMode?: string[];
  colorTemperature?: { min: number; max: number; step: number };
};

export type ExtendedCameraSettings = MediaTrackSettings & {
  exposureMode?: string;
  exposureTime?: number;
  exposureCompensation?: number;
  iso?: number;
  focusMode?: string;
  focusDistance?: number;
  whiteBalanceMode?: string;
  colorTemperature?: number;
};

export type CameraSnapshot = {
  label: string;
  capabilities: ExtendedCameraCapabilities;
  settings: ExtendedCameraSettings;
};

export async function enumerateVideoInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "videoinput");
}
export async function openCamera(
  deviceId?: string,
): Promise<{ stream: MediaStream; snapshot: CameraSnapshot }> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前页面没有摄像头访问能力，请使用 HTTPS/localhost，或改用图片与仿真模式。");
  }

  const video: MediaTrackConstraints = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 60 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };

  const stream = await navigator.mediaDevices.getUserMedia({
    video,
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  const capabilities = (
    typeof track.getCapabilities === "function" ? track.getCapabilities() : {}
  ) as ExtendedCameraCapabilities;
  const settings = track.getSettings() as ExtendedCameraSettings;

  return {
    stream,
    snapshot: {
      label: track.label || "Camera",
      capabilities,
      settings,
    },
  };
}

export function closeCamera(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export async function lockCurrentCameraSettings(
  stream: MediaStream,
): Promise<CameraSnapshot> {
  const track = stream.getVideoTracks()[0];
  const capabilities = track.getCapabilities() as ExtendedCameraCapabilities;
  const settings = track.getSettings() as ExtendedCameraSettings;
  const advanced: Record<string, string | number>[] = [];

  const requested: Record<string, string | number> = {};
  if (capabilities.exposureMode?.includes("manual") && settings.exposureTime != null) {
    requested.exposureMode = "manual";
    requested.exposureTime = settings.exposureTime;
  }
  if (capabilities.focusMode?.includes("manual") && settings.focusDistance != null) {
    requested.focusMode = "manual";
    requested.focusDistance = settings.focusDistance;
  }
  if (capabilities.whiteBalanceMode?.includes("manual") && settings.colorTemperature != null) {
    requested.whiteBalanceMode = "manual";
    requested.colorTemperature = settings.colorTemperature;
  }
  if (Object.keys(requested).length > 0) advanced.push(requested);

  if (advanced.length > 0) {
    await track.applyConstraints({
      advanced: advanced as MediaTrackConstraintSet[],
    });
  }

  return {
    label: track.label || "Camera",
    capabilities,
    settings: track.getSettings() as ExtendedCameraSettings,
  };
}
