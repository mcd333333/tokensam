/**
 * Display smoothing for noisy provider series.
 *
 * CoinGecko's 24-hour volume for some low-volume tokens flips between two levels from one 15-minute reading to the
 * next (Theta Fuel: more than 25% between consecutive readings 34% of the time over a recent 3-day window, Axelar
 * 42%, Bitcoin 0%). Drawn raw, each flip becomes a vertical bar and the chart reads as a barcode. A centred rolling
 * median removes isolated and short-run flips while keeping any move that lasts: a real spike that holds for more
 * than about half the window survives intact.
 *
 * Only granular points are smoothed. Daily averages (points carrying `aggregation`) are already means over a UTC day,
 * so they are left alone and also break a granular run, so a window never spans an average and a raw reading.
 */
export const VOLUME_SMOOTHING_WINDOW = 7;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Rolling median over `window` readings, centred on each point. Near either end the window slides inward so it always
 * holds a full `window` readings (it does not shrink): a shrunken window at the newest end can hold as many flipped
 * readings as normal ones and let a spike through, and the newest points are the ones people read. With fewer readings
 * than `window` the median is taken over all of them.
 */
export function rollingMedian(values: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  const size = Math.min(window, values.length);
  return values.map((_, index) => {
    const start = Math.min(Math.max(0, index - half), values.length - size);
    return median(values.slice(start, start + size));
  });
}

/**
 * Returns the points with `valueUsd` replaced by the rolling median of its neighbours, run by run. Timestamps and
 * source ids are unchanged. Points are expected in time order.
 */
export function smoothGranularPoints<T extends { valueUsd: number; aggregation?: unknown }>(points: T[], window = VOLUME_SMOOTHING_WINDOW): T[] {
  const out: T[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const smoothed = rollingMedian(run.map((point) => point.valueUsd), window);
    run.forEach((point, index) => out.push({ ...point, valueUsd: smoothed[index] }));
    run = [];
  };
  for (const point of points) {
    if (point.aggregation) {
      flush();
      out.push(point);
    } else {
      run.push(point);
    }
  }
  flush();
  return out;
}
