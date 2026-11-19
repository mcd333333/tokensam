"use client";

import type { Methodology } from "@/lib/ui/profile-model";

/**
 * Methodology, collapsed by default and kept short: what Token Samurai does
 * with data, how it is treated, and the real limitations. Metrics that cannot be
 * computed are not listed (they are simply not shown elsewhere); formulas and the
 * external services behind each dataset ("Data provenance") sit in nested
 * disclosures. Internal database identifiers and provider-specific slugs are never
 * shown. Raw collection notes (ingestion, aggregation and missing-field details)
 * stay in the model for audit but are not rendered.
 */
export function SourcesMethodology({ methodology, corporateProfileSource, corporateProfileLinks, open, onToggle }: {
  methodology: Methodology;
  corporateProfileSource?: string;
  /** Attribution links for profiles built from CryptoRank/press data (profile, funding amount, investor list). */
  corporateProfileLinks?: { label: string; href: string }[];
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
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
            <ul className="method-list method-list-columns">
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
            {corporateProfileSource ? (
              <div>
                <dt>Corporate profile and fundraising</dt>
                <dd><a href={corporateProfileSource} target="_blank" rel="noopener noreferrer">RootData</a></dd>
              </div>
            ) : corporateProfileLinks && corporateProfileLinks.length > 0 ? (
              <div>
                <dt>Corporate profile and fundraising</dt>
                <dd>
                  {corporateProfileLinks.map((link, index) => (
                    <span key={link.href}>
                      {index > 0 ? " · " : null}
                      <a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a>
                    </span>
                  ))}
                </dd>
              </div>
            ) : null}
          </dl>
        </details>
      </div>
    </details>
  );
}
