"use client";

import { useSyncExternalStore } from "react";
import type { Methodology } from "@/lib/ui/profile-model";
import { formatUtc } from "@/lib/ui/format";
import { FRESHNESS_DISPLAY_MAX_AGE_MS, liveFreshnessRow, visibleFreshness, type LivePriceStatus } from "@/lib/ui/freshness-display";

const CLOCK_TICK_MS = 15_000;
function subscribeToClock(onChange: () => void): () => void {
  const timer = setInterval(onChange, CLOCK_TICK_MS);
  return () => clearInterval(timer);
}
/** The clock rounded down to the tick, so the snapshot is stable between ticks and React re-renders only when it moves. */
function clockSnapshot(): number {
  return Math.floor(Date.now() / CLOCK_TICK_MS) * CLOCK_TICK_MS;
}
function serverClockSnapshot(): null {
  return null;
}

/**
 * The visitor's clock, to within 15 seconds, or null on the server and during hydration, so both render the same markup
 * and the freshness rules (which depend on the visitor's own time) are applied right after.
 */
function useNow(): number | null {
  return useSyncExternalStore<number | null>(subscribeToClock, clockSnapshot, serverClockSnapshot);
}

/**
 * Methodology, collapsed by default and kept short: what Token Samurai does
 * with data, how it is treated, how fresh each dataset is for this token, and
 * the real limitations. Metrics that cannot be computed are not listed (they
 * are simply not shown elsewhere); formulas and the external services behind
 * each dataset ("Data provenance") sit in nested disclosures. Internal database
 * identifiers and provider-specific slugs are never shown. Raw collection notes
 * (ingestion, aggregation and missing-field details) stay in the model for
 * audit but are not rendered: the one research-relevant qualification, the
 * reference-price caveat, is shown under Data freshness.
 */
export function SourcesMethodology({ methodology, livePrice, open, onToggle }: {
  methodology: Methodology;
  /** Which live feed quotes this token and when it was last confirmed; drives the "Live exchange price" row. */
  livePrice?: LivePriceStatus;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const now = useNow();
  const freshness = visibleFreshness(methodology.freshness, now);
  const liveRow = liveFreshnessRow(livePrice, now);
  const hiddenCount = methodology.freshness.length - freshness.length;
  return (
    <details className="methodology" id="sources" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
      <summary>
        <span className="methodology-title">Sources &amp; methodology</span>
        <span className="methodology-caption">How this data is collected, normalized, and calculated</span>
        <span className="methodology-chevron" aria-hidden="true" />
      </summary>

      <div className="methodology-body">
        <p className="methodology-lede">
          Token Samurai aggregates market, protocol, DEX, and available on-chain data from multiple external sources,
          normalizes observations, and calculates deterministic research metrics.
        </p>
        <div className="methodology-grid">
          <section aria-labelledby="sources-treatment">
            <h3 id="sources-treatment">Data treatment</h3>
            <ul className="method-list">
              <li>Latest available observations are used.</li>
              <li>Missing values are not replaced with zero.</li>
              <li>Token, protocol, and DEX data are kept separate.</li>
              <li>
                Protocol metrics describe the associated protocol{methodology.protocolName ? ` (${methodology.protocolName})` : ""} and
                are not necessarily token-level measurements.
              </li>
              <li>Calculated metrics use explicitly defined formulas and the actual interval between observations.</li>
              <li>Technical indicators use daily closes from stored history and appear only when their full input window exists.</li>
              <li>Wrapped assets are not used as proxies for native assets.</li>
            </ul>
            <h3 className="methodology-subhead">Limitations</h3>
            <ul className="method-list">
              <li>Emissions and unlock schedules are not currently collected.</li>
              <li>Historical DEX liquidity is not currently used; DEX metrics reflect the latest snapshot.</li>
            </ul>
          </section>

          <section aria-labelledby="sources-freshness">
            <h3 id="sources-freshness">Data freshness</h3>
            {freshness.length > 0 || liveRow ? (
              <ul className="freshness-list" aria-label="Data freshness for this token">
                {liveRow ? (
                  <li key="live-exchange-price" className="freshness-row current">
                    <span className="freshness-dot" aria-hidden="true" />
                    <span className="freshness-label">{liveRow.label}</span>
                    <span className="freshness-age" title="Streamed from the exchange into this page; the price shown in the header is this price.">{liveRow.text}</span>
                  </li>
                ) : null}
                {freshness.map((item) => (
                  <li key={item.label} className={`freshness-row ${item.state ?? "neutral"}`}>
                    <span className="freshness-dot" aria-hidden="true" />
                    <span className="freshness-label">{item.label}</span>
                    <span
                      className="freshness-age"
                      title={[
                        `${item.kind === "calculation" ? "Calculated" : "Collected"} ${formatUtc(item.collectedAt)}`,
                        item.observedAt ? `observed ${formatUtc(item.observedAt)}` : null,
                      ].filter(Boolean).join(" · ")}
                    >
                      {item.ageLabel}
                      {item.state === "stale" ? <b> · Stale</b> : item.state === "current" ? " · Current" : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-copy">
                {methodology.freshness.length === 0
                  ? "No data has been collected for this token yet."
                  : `No dataset was refreshed in the last ${FRESHNESS_DISPLAY_MAX_AGE_MS / 60_000} minutes.`}
              </p>
            )}
            {hiddenCount > 0 ? (
              <p className="methodology-note">
                Datasets last refreshed more than {FRESHNESS_DISPLAY_MAX_AGE_MS / 60_000} minutes ago are not listed here.
              </p>
            ) : null}
            {methodology.referencePrice ? (
              <p className="methodology-note">
                Reference token price <b className="numeric">{methodology.referencePrice.value}</b>
                {" "}({formatUtc(methodology.referencePrice.observedAt)}) is a secondary token-level price. It may share upstream data
                with the market price, so it is not independent confirmation.
              </p>
            ) : null}
          </section>
        </div>

        {methodology.formulas.length > 0 ? (
          <details className="methodology-sub">
            <summary>Formulas for calculated metrics shown ({methodology.formulas.length})</summary>
            <dl className="formula-list">
              {methodology.formulas.map((item) => <div key={item.label}><dt>{item.label}</dt><dd><code>{item.formula}</code></dd></div>)}
            </dl>
          </details>
        ) : null}

        <details className="methodology-sub technical">
          <summary>Data provenance</summary>
          <dl className="identifier-list">
            {methodology.identifiers.map((item) => (
              <div key={`${item.label}-${item.value}`}>
                <dt>{item.label}</dt>
                <dd><code>{item.value}</code>{item.note ? <small>{item.note}</small> : null}</dd>
              </div>
            ))}
            {methodology.provenance.datasets.map((item) => (
              <div key={item.dataset}>
                <dt>{item.dataset}</dt>
                <dd>{item.provider}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </details>
  );
}
