import type { ImageDataLike } from "./signal";

export type DiffractionKind = "single-slit" | "double-slit";

export interface DiffractionSimulationOptions {
  readonly kind?: DiffractionKind | "single" | "double";
  /** Alias for kind. */
  readonly type?: DiffractionKind | "single" | "double";
  readonly width?: number;
  readonly height?: number;
  /** Vacuum wavelength in nanometres. */
  readonly wavelengthNm?: number;
  /** Short alias for wavelengthNm. */
  readonly lambdaNm?: number;
  /** Compact alias for wavelengthNm (still expressed in nanometres). */
  readonly lambda?: number;
  /** Physical width of each slit in millimetres. */
  readonly slitWidthMm?: number;
  /** Short alias for slitWidthMm. */
  readonly aMm?: number;
  /** Compact alias for slitWidthMm (still expressed in millimetres). */
  readonly a?: number;
  /** Centre-to-centre separation of a double slit in millimetres. */
  readonly slitSeparationMm?: number;
  /** Short alias for slitSeparationMm. */
  readonly dMm?: number;
  /** Compact alias for slitSeparationMm (still expressed in millimetres). */
  readonly d?: number;
  /** Slit-plane to screen-plane distance in metres. */
  readonly screenDistanceM?: number;
  /** Short alias for screenDistanceM. */
  readonly Lm?: number;
  /** Compact alias for screenDistanceM (still expressed in metres). */
  readonly L?: number;
  readonly mmPerPixel?: number;
  /** Standard deviation of additive camera noise, as a fraction of full scale. */
  readonly noiseStd?: number;
  /** Alias for noiseStd. */
  readonly noise?: number;
  /** Encoding gamma. 1 preserves a linear response; 2.2 applies x^(1/2.2). */
  readonly gamma?: number;
  /** Linear clipping point in (0, 1]; values at this level encode as 255. */
  readonly saturationLevel?: number;
  /** Alias for saturationLevel. */
  readonly saturation?: number;
  /** Rotation of the profile normal; 0 produces vertical fringes. */
  readonly rotationDeg?: number;
  /** Alias for rotationDeg. */
  readonly rotation?: number;
  readonly seed?: number;
  /** Uniform linear background as a fraction of full scale. */
  readonly background?: number;
  /** Optional RGB response multipliers in [0, 1]. */
  readonly color?: Readonly<{ r: number; g: number; b: number }>;
  readonly centerX?: number;
  readonly centerY?: number;
  /** Double-slit fringe visibility in [0, 1]. */
  readonly visibility?: number;
}

export interface ResolvedSimulationParameters {
  readonly kind: DiffractionKind;
  readonly width: number;
  readonly height: number;
  readonly wavelengthNm: number;
  readonly slitWidthMm: number;
  readonly slitSeparationMm: number;
  readonly screenDistanceM: number;
  readonly mmPerPixel: number;
  readonly noiseStd: number;
  readonly gamma: number;
  readonly saturationLevel: number;
  readonly rotationDeg: number;
  readonly seed: number;
  readonly background: number;
  readonly color: Readonly<{ r: number; g: number; b: number }>;
  readonly centerX: number;
  readonly centerY: number;
  readonly visibility: number;
}

export interface DiffractionSimulationResult {
  readonly frame: ImageDataLike & { readonly data: Uint8ClampedArray };
  /** Alias convenient for Canvas/ImageData consumers. */
  readonly imageData: ImageDataLike & { readonly data: Uint8ClampedArray };
  /** Ideal, linear, noise-free physical intensity along the profile normal. */
  readonly truthProfile: Float64Array;
  /** Noise-free camera-encoded profile in DN, using the strongest RGB channel. */
  readonly encodedProfile: Float64Array;
  readonly xMm: Float64Array;
  readonly parameters: ResolvedSimulationParameters;
  /** Small-angle prediction; null for a single slit. */
  readonly expectedFringeSpacingMm: number | null;
  /** Exact screen displacement between m=0 and m=1; null for a single slit. */
  readonly exactFirstOrderDisplacementMm: number | null;
  /** First single-slit zero displacement from centre, using exact geometry. */
  readonly exactFirstEnvelopeZeroMm: number | null;
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive and finite`);
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function sinc(value: number): number {
  return Math.abs(value) < 1e-12 ? 1 : Math.sin(value) / value;
}

function inferLaserColor(wavelengthNm: number): Readonly<{ r: number; g: number; b: number }> {
  if (wavelengthNm >= 590) return { r: 1, g: 0.07, b: 0.025 };
  if (wavelengthNm >= 500) return { r: 0.035, g: 1, b: 0.06 };
  return { r: 0.04, g: 0.16, b: 1 };
}

/** Mulberry32 is small, deterministic, and adequate for reproducible synthetic camera noise. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGaussian(random: () => number): () => number {
  let spare: number | null = null;
  return (): number => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    while (u <= Number.EPSILON) u = random();
    while (v <= Number.EPSILON) v = random();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

function resolveOptions(options: DiffractionSimulationOptions): ResolvedSimulationParameters {
  const rawKind = options.kind ?? options.type ?? "double-slit";
  const kind: DiffractionKind = rawKind === "single" || rawKind === "single-slit"
    ? "single-slit"
    : "double-slit";
  const width = Math.round(finitePositive(options.width ?? 641, "width"));
  const height = Math.round(finitePositive(options.height ?? 160, "height"));
  const wavelengthNm = finitePositive(
    options.wavelengthNm ?? options.lambdaNm ?? options.lambda ?? 650,
    "wavelengthNm",
  );
  const slitWidthMm = finitePositive(options.slitWidthMm ?? options.aMm ?? options.a ?? 0.04, "slitWidthMm");
  const slitSeparationMm = finitePositive(
    options.slitSeparationMm ?? options.dMm ?? options.d ?? 0.25,
    "slitSeparationMm",
  );
  if (kind === "double-slit" && slitSeparationMm <= slitWidthMm) {
    throw new RangeError("slitSeparationMm must exceed slitWidthMm for a double slit");
  }
  const screenDistanceM = finitePositive(options.screenDistanceM ?? options.Lm ?? options.L ?? 1, "screenDistanceM");
  const mmPerPixel = finitePositive(options.mmPerPixel ?? 0.05, "mmPerPixel");
  const noiseStd = options.noiseStd ?? options.noise ?? 0;
  if (!Number.isFinite(noiseStd) || noiseStd < 0) throw new RangeError("noiseStd must be finite and non-negative");
  const gamma = finitePositive(options.gamma ?? 1, "gamma");
  const saturationLevel = options.saturationLevel ?? options.saturation ?? 1;
  if (!Number.isFinite(saturationLevel) || saturationLevel <= 0 || saturationLevel > 1) {
    throw new RangeError("saturationLevel must be in (0, 1]");
  }
  const rotationDeg = options.rotationDeg ?? options.rotation ?? 0;
  if (!Number.isFinite(rotationDeg)) throw new RangeError("rotationDeg must be finite");
  const seed = Math.trunc(options.seed ?? 1);
  if (!Number.isFinite(seed)) throw new RangeError("seed must be finite");
  const background = options.background ?? 0;
  if (!Number.isFinite(background) || background < 0 || background >= 1) {
    throw new RangeError("background must be in [0, 1)");
  }
  const rawColor = options.color ?? inferLaserColor(wavelengthNm);
  const color = {
    r: clamp(rawColor.r, 0, 1),
    g: clamp(rawColor.g, 0, 1),
    b: clamp(rawColor.b, 0, 1),
  };
  if (![rawColor.r, rawColor.g, rawColor.b].every(Number.isFinite)) {
    throw new RangeError("color components must be finite");
  }
  const centerX = options.centerX ?? (width - 1) / 2;
  const centerY = options.centerY ?? (height - 1) / 2;
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) throw new RangeError("centre must be finite");
  const visibility = options.visibility ?? 1;
  if (!Number.isFinite(visibility) || visibility < 0 || visibility > 1) {
    throw new RangeError("visibility must be in [0, 1]");
  }

  return {
    kind,
    width,
    height,
    wavelengthNm,
    slitWidthMm,
    slitSeparationMm,
    screenDistanceM,
    mmPerPixel,
    noiseStd,
    gamma,
    saturationLevel,
    rotationDeg,
    seed,
    background,
    color,
    centerX,
    centerY,
    visibility,
  };
}

function physicalIntensityAt(screenPositionMm: number, parameters: ResolvedSimulationParameters): number {
  const xM = screenPositionMm / 1000;
  const wavelengthM = parameters.wavelengthNm * 1e-9;
  const slitWidthM = parameters.slitWidthMm / 1000;
  const slitSeparationM = parameters.slitSeparationMm / 1000;
  const sineTheta = xM / Math.sqrt(parameters.screenDistanceM ** 2 + xM ** 2);
  const beta = Math.PI * slitWidthM * sineTheta / wavelengthM;
  const envelope = sinc(beta) ** 2;
  if (parameters.kind === "single-slit") return envelope;
  const alpha = Math.PI * slitSeparationM * sineTheta / wavelengthM;
  const interference = (1 + parameters.visibility * Math.cos(2 * alpha)) / 2;
  return clamp(envelope * interference, 0, 1);
}

function encodeLinearIntensity(linearIntensity: number, parameters: ResolvedSimulationParameters): number {
  const withBackground = parameters.background + (1 - parameters.background) * clamp(linearIntensity, 0, 1);
  const clipped = Math.min(withBackground, parameters.saturationLevel) / parameters.saturationLevel;
  return clamp(clipped, 0, 1) ** (1 / parameters.gamma);
}

function exactDisplacementMm(orderRatio: number, distanceM: number): number | null {
  if (Math.abs(orderRatio) >= 1) return null;
  const theta = Math.asin(orderRatio);
  return distanceM * Math.tan(theta) * 1000;
}

/**
 * Generates a physically modelled Fraunhofer pattern and a camera-like RGBA
 * frame. The ideal profile always remains linear even if gamma, clipping, or
 * noise are requested for the frame.
 */
export function simulateDiffraction(
  options: DiffractionSimulationOptions = {},
): DiffractionSimulationResult {
  const parameters = resolveOptions(options);
  const { width, height } = parameters;
  const random = makeRandom(parameters.seed);
  const gaussian = makeGaussian(random);
  const radians = parameters.rotationDeg * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);

  const truthProfile = new Float64Array(width);
  const encodedProfile = new Float64Array(width);
  const xMm = new Float64Array(width);
  const strongestColor = Math.max(parameters.color.r, parameters.color.g, parameters.color.b);
  for (let x = 0; x < width; x += 1) {
    const positionMm = (x - parameters.centerX) * parameters.mmPerPixel;
    const intensity = physicalIntensityAt(positionMm, parameters);
    xMm[x] = positionMm;
    truthProfile[x] = intensity;
    encodedProfile[x] = 255 * strongestColor * encodeLinearIntensity(intensity, parameters);
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const dy = y - parameters.centerY;
    for (let x = 0; x < width; x += 1) {
      const dx = x - parameters.centerX;
      const normalPositionMm = (dx * cosine + dy * sine) * parameters.mmPerPixel;
      const ideal = physicalIntensityAt(normalPositionMm, parameters);
      const noisy = ideal + (parameters.noiseStd > 0 ? gaussian() * parameters.noiseStd : 0);
      const encoded = encodeLinearIntensity(noisy, parameters);
      const offset = (y * width + x) * 4;
      data[offset] = Math.round(255 * encoded * parameters.color.r);
      data[offset + 1] = Math.round(255 * encoded * parameters.color.g);
      data[offset + 2] = Math.round(255 * encoded * parameters.color.b);
      data[offset + 3] = 255;
    }
  }

  const frame = { width, height, data } as const;
  const wavelengthM = parameters.wavelengthNm * 1e-9;
  const separationM = parameters.slitSeparationMm * 1e-3;
  const widthM = parameters.slitWidthMm * 1e-3;
  const expectedFringeSpacingMm = parameters.kind === "double-slit"
    ? wavelengthM * parameters.screenDistanceM / separationM * 1000
    : null;
  const exactFirstOrderDisplacementMm = parameters.kind === "double-slit"
    ? exactDisplacementMm(wavelengthM / separationM, parameters.screenDistanceM)
    : null;
  const exactFirstEnvelopeZeroMm = exactDisplacementMm(
    wavelengthM / widthM,
    parameters.screenDistanceM,
  );

  return {
    frame,
    imageData: frame,
    truthProfile,
    encodedProfile,
    xMm,
    parameters,
    expectedFringeSpacingMm,
    exactFirstOrderDisplacementMm,
    exactFirstEnvelopeZeroMm,
  };
}

export const generateDiffractionFrame = simulateDiffraction;
