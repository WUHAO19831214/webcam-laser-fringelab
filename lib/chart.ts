export const CHART_DISPLAY_CEILING = 0.98;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
function quantile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = clamp(fraction, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Normalises a display series while reserving visible headroom above its true
 * maximum. The absolute maximum, rather than p98, defines the upper scale so
 * no late-arriving sample can be drawn beyond the labelled 100% grid line.
 */
export function normalizeChartSeries(
  input: readonly number[],
  ceiling = CHART_DISPLAY_CEILING,
): number[] {
  if (input.length === 0) return [];
  const values = input.map((value) => Number.isFinite(value) ? value : 0);
  const low = quantile(values, 0.02);
  const high = Math.max(...values);
  const range = high - low;
  const safeCeiling = clamp(ceiling, 0, 1);
  if (range <= Number.EPSILON) return values.map(() => 0);
  return values.map((value) =>
    clamp(((value - low) / range) * safeCeiling, 0, safeCeiling),
  );
}
