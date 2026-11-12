export const DIRECTION_UP_COLOR = "#8bc9ac";
export const DIRECTION_DOWN_COLOR = "#e2766d";

type TimedPoint = { time: number; valueUsd: number };

/** The trend window is this fraction of the series' time span, so a chart shows about 30 colour runs however many points it has. */
export const TREND_WINDOW_FRACTION = 1 / 30;

/**
 * Trend colour of each point: green when its value is at or above the value one trend window earlier, red when below.
 * Comparing against a window earlier, not the previous point, keeps choppy stretches from flipping colour on every tick.
 * Points in the first window compare with the first point. A flat step keeps the previous colour.
 */
export function trendColors(points: TimedPoint[], windowFraction = TREND_WINDOW_FRACTION): string[] {
  if (points.length < 2) return points.map(() => DIRECTION_UP_COLOR);
  const start = points[0].time;
  const span = points[points.length - 1].time - start;
  const windowMs = span * windowFraction;
  const colors: string[] = [];
  let previous = DIRECTION_UP_COLOR;
  let base = 0;
  for (let index = 0; index < points.length; index += 1) {
    while (base + 1 < index && points[base + 1].time <= points[index].time - windowMs) base += 1;
    const reference = index === 0 ? points[1] : points[base];
    const delta = index === 0 ? reference.valueUsd - points[0].valueUsd : points[index].valueUsd - reference.valueUsd;
    if (delta > 0) previous = DIRECTION_UP_COLOR;
    else if (delta < 0) previous = DIRECTION_DOWN_COLOR;
    colors.push(previous);
  }
  return colors;
}

/**
 * Hard-stop gradient stops that colour the line by trend (see trendColors): the stretch ending at each point takes that
 * point's colour. Stops sit at each point's share of the time axis, which is how the line is laid out, and consecutive
 * same-colour stretches are merged. A perfectly flat line has no direction (and a zero-height bounding box, where an
 * objectBoundingBox gradient paints nothing), so it gets no stops.
 */
export function directionStops(points: TimedPoint[], windowFraction = TREND_WINDOW_FRACTION): { offset: number; color: string }[] {
  if (points.length < 2) return [];
  const start = points[0].time;
  const span = points[points.length - 1].time - start;
  if (span <= 0) return [];
  if (points.every((point) => point.valueUsd === points[0].valueUsd)) return [];
  const colors = trendColors(points, windowFraction);
  const steps: { from: number; to: number; color: string }[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = (points[index - 1].time - start) / span;
    const to = (points[index].time - start) / span;
    const last = steps.at(-1);
    if (last && last.color === colors[index]) last.to = to;
    else steps.push({ from, to, color: colors[index] });
  }
  return steps.flatMap((step) => [{ offset: step.from, color: step.color }, { offset: step.to, color: step.color }]);
}
