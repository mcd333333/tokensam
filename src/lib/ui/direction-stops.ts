export const DIRECTION_UP_COLOR = "#8bc9ac";
export const DIRECTION_DOWN_COLOR = "#e2766d";
const UP_COLOR = DIRECTION_UP_COLOR;
const DOWN_COLOR = DIRECTION_DOWN_COLOR;

/**
 * Hard-stop gradient stops that colour each stretch of the line by its direction: green where the value rose from the
 * previous point, red where it fell (a flat step keeps the previous colour). Stops sit at each point's share of the
 * time axis, which is how the line itself is laid out, and consecutive same-direction steps are merged.
 */
export function directionStops(points: { time: number; valueUsd: number }[]): { offset: number; color: string }[] {
  if (points.length < 2) return [];
  const start = points[0].time;
  const span = points[points.length - 1].time - start;
  if (span <= 0) return [];
  // A perfectly flat line has a zero-height bounding box, where an objectBoundingBox gradient paints nothing.
  if (points.every((point) => point.valueUsd === points[0].valueUsd)) return [];
  const steps: { from: number; to: number; color: string }[] = [];
  let color = points[1].valueUsd >= points[0].valueUsd ? UP_COLOR : DOWN_COLOR;
  for (let index = 1; index < points.length; index += 1) {
    const delta = points[index].valueUsd - points[index - 1].valueUsd;
    if (delta > 0) color = UP_COLOR;
    else if (delta < 0) color = DOWN_COLOR;
    const from = (points[index - 1].time - start) / span;
    const to = (points[index].time - start) / span;
    const last = steps.at(-1);
    if (last && last.color === color) last.to = to;
    else steps.push({ from, to, color });
  }
  return steps.flatMap((step) => [{ offset: step.from, color: step.color }, { offset: step.to, color: step.color }]);
}
