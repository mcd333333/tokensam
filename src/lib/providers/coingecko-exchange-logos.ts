import { CoinGeckoApiError, MIN_REQUEST_INTERVAL_MS, getCoinGeckoConfig, retryAfterMs } from "./coingecko.ts";

/**
 * Exchange logos from CoinGecko's `GET /exchanges` (250 per page, centralised and decentralised exchanges together,
 * each with an `image` URL). The whole list is about four pages, so it is pulled once and refreshed rarely.
 */
export type ExchangeLogo = { id: string; name: string; logo: string };

export const EXCHANGE_LOGO_PAGE_SIZE = 250;
/** Safety ceiling: the list was 4 pages (936 exchanges) when written. */
export const EXCHANGE_LOGO_MAX_PAGES = 8;

/** Keeps entries with an id, a name and an https image; everything else is dropped. */
export function normalizeExchangeLogos(payload: unknown): ExchangeLogo[] {
  if (!Array.isArray(payload)) return [];
  const out: ExchangeLogo[] = [];
  for (const item of payload as { id?: unknown; name?: unknown; image?: unknown }[]) {
    if (typeof item?.id !== "string" || !item.id || typeof item.name !== "string" || typeof item.image !== "string") continue;
    if (!/^https:\/\//.test(item.image)) continue;
    out.push({ id: item.id, name: item.name, logo: item.image });
  }
  return out;
}

/** Reads pages until one comes back short or empty. `onCall` runs before every request so the caller can count it. */
export async function fetchAllExchangeLogos(
  options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; env?: Record<string, string | undefined>; onCall?: () => Promise<void> } = {},
): Promise<ExchangeLogo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const config = getCoinGeckoConfig(options.env);
  const all = new Map<string, ExchangeLogo>();

  for (let page = 1; page <= EXCHANGE_LOGO_MAX_PAGES; page += 1) {
    const url = new URL(`${config.baseUrl}/exchanges`);
    url.searchParams.set("per_page", String(EXCHANGE_LOGO_PAGE_SIZE));
    url.searchParams.set("page", String(page));
    let payload: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await options.onCall?.();
      let response: Response;
      try {
        response = await fetchImpl(url, { method: "GET", headers: { [config.keyHeader]: config.apiKey, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      } catch {
        if (attempt === 2) throw new CoinGeckoApiError("CoinGecko exchanges request failed due to a network error.", null);
        await sleep(1_000);
        continue;
      }
      if (response.ok) { payload = await response.json(); break; }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) throw new CoinGeckoApiError(`CoinGecko exchanges returned HTTP ${response.status}.`, response.status);
      await sleep(response.status === 429 ? retryAfterMs(response.headers.get("retry-after"), 2_000) : 1_000);
    }
    const raw = Array.isArray(payload) ? payload : [];
    for (const entry of normalizeExchangeLogos(raw)) all.set(entry.id, entry);
    if (raw.length < EXCHANGE_LOGO_PAGE_SIZE) break;
    await sleep(MIN_REQUEST_INTERVAL_MS);
  }
  return [...all.values()];
}
