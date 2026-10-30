"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import type { LiveTokenProfileData } from "@/types/token";
import { buildProfileModel, type Card, type PoolRow } from "@/lib/ui/profile-model";
import { buildProfilePayload, formatProfilePayloadText } from "@/lib/analysis/profile-payload";
import { formatChange, formatUsd, shortAddress } from "@/lib/ui/format";
import { HistoryCharts } from "@/components/HistoricalSection";
import { IndicatorCard, TechnicalIndicators } from "@/components/TechnicalIndicators";
import { DeepAnalysisPanel } from "@/components/DeepAnalysisPanel";
import { SourcesMethodology } from "@/components/SourcesMethodology";
import { TokenLogo } from "@/components/TokenLogo";
import { CopyButton } from "@/components/CopyButton";
import { PageFooter } from "@/components/AppShell";
import "./TokenProfile.css";

function Change({ value, label }: { value: number | null; label: string }) {
  const change = formatChange(value);
  if (!change) return null;
  return <span className="hero-change"><small>{label}</small><b className={`tone-${change.tone}`}>{change.text}</b></span>;
}

function SectionHead({ eyebrow, title, id, children }: { eyebrow: string; title: string; id: string; children?: ReactNode }) {
  return (
    <header className="section-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={id}>{title}</h2>
      </div>
      {children}
    </header>
  );
}

function Tile({ item, emphasis = false }: { item: Card; emphasis?: boolean }) {
  return (
    <div className={`tile${emphasis ? " tile-emphasis" : ""}`} title={item.title}>
      <span className="tile-label">{item.label}</span>
      <strong className={`tile-value tone-${item.tone}`}>{item.value}</strong>
      {item.note ? <span className="tile-note">{item.note}</span> : null}
    </div>
  );
}

function MetricList({ title, items }: { title: string; items: Card[] }) {
  if (items.length === 0) return null;
  return (
    <div className="metric-list">
      <h3>{title}</h3>
      <dl>
        {items.map((item) => (
          <div key={item.id} className="metric-row" title={item.title}>
            <dt>{item.label}{item.note ? <small>{item.note}</small> : null}</dt>
            <dd className={`tone-${item.tone}`}>{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** One row per on-chain pool: DEX, pool address (copyable), and its own liquidity/volume. */
function PoolList({ pools }: { pools: PoolRow[] }) {
  if (pools.length === 0) return null;
  return (
    <ul className="pool-list">
      {pools.map((pool) => (
        <li key={pool.id} className="pool-row">
          <span className="pool-dex chip">{pool.dexLabel}</span>
          <span className="address"><code title={pool.pairAddress}>{shortAddress(pool.pairAddress)}</code><CopyButton value={pool.pairAddress} label="pool address" /></span>
          <span className="pool-figures">
            {pool.liquidity ? <span><small>Liquidity</small>{pool.liquidity}</span> : null}
            {pool.volume24h ? <span><small>Volume · 24h</small>{pool.volume24h}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Signals({ items, title = "Divergence signals" }: { items: Card[]; title?: string }) {
  if (items.length === 0) return null;
  const interval = items.find((item) => item.note)?.note;
  return (
    <div className="signals">
      <h3>{title}{interval ? <small>{interval}</small> : null}</h3>
      <ul>
        {items.map((item) => (
          <li key={item.id} className={item.value === "Observed" ? "signal observed" : "signal"} title={item.title}>
            <span className="signal-mark" aria-hidden="true" />
            <span>{item.label}</span>
            <b>{item.value}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TokenProfile({ data }: { data: LiveTokenProfileData }) {
  const { token } = data;
  const model = useMemo(() => buildProfileModel(data), [data]);
  const payload = useMemo(() => buildProfilePayload(data), [data]);
  const copyData = useMemo(() => formatProfilePayloadText(payload), [payload]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("overview");
  useEffect(() => {
    const sections = model.sections.map((section) => document.getElementById(section.id))
      .filter((element): element is HTMLElement => element !== null);
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = sections[0]?.id ?? "overview";
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= 160) current = section.id;
      }
      setActiveSection(current);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [model.sections]);
  // Clicking the header's AI research report button scrolls to the report section
  // and starts generation there; incrementing this counter is the signal DeepAnalysisPanel watches
  // (see its own useEffect) to start a fresh generation even if one is already showing.
  const [autoGenerateSignal, setAutoGenerateSignal] = useState(0);
  const price = formatUsd(token.priceUsd);
  const marketCap = formatUsd(token.marketCapUsd, true);
  // Sections without data are simply omitted (page and nav); no "not available" cards are rendered.
  const { fundamentals, marketStructure, dexMarkets, onchainIdentity, tokenomics, history, technical, divergence } = model;
  const hasCrossMetric = divergence.comparisons.length + divergence.signals.length + divergence.indicators.length > 0;

  const reveal = (id: string) => window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }));
  const openAnalysis = () => { setAutoGenerateSignal((signal) => signal + 1); reveal("analysis"); };

  return (
    <div className="page profile-page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">Research Universe</Link><span aria-hidden="true">/</span><span aria-current="page">{token.name}</span>
      </nav>

      <header className="profile-header" id="overview">
        <div className="profile-identity">
          <TokenLogo src={data.logoUrl} symbol={token.symbol} size={52} />
          <div className="identity-copy">
            <p className="profile-kicker">Token research</p>
            <h1>{token.name} <span className="symbol">{token.symbol}</span></h1>
            <div className="identity-meta">
              <span>{token.chain}</span>
              <span className="chip">{token.category}</span>
              {data.isNative ? <span className="native-tag">Native asset</span> : data.contractAddress ? (
                <span className="address"><code title={data.contractAddress}>{shortAddress(data.contractAddress)}</code><CopyButton value={data.contractAddress} label="contract address" /></span>
              ) : null}
              {/* The same canonical dataset the AI analysis receives, as readable text. */}
              <CopyButton value={copyData} label="token data shown on this page" text="Copy data" />
            </div>
          </div>
        </div>
        <button className="profile-report-button" type="button" onClick={openAnalysis} aria-controls="deep-ai-analysis" aria-label="Generate a fresh AI research report">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6ZM8 12l3 3 5-6" /></svg>
          <span>AI research report<small>Generate a fresh analysis</small></span>
          <span className="report-arrow" aria-hidden="true">→</span>
        </button>
        <div className="profile-quote">
          <span className="profile-kicker">Token price · USD</span>
          {price ? <strong className="quote-price">{price}</strong> : <strong className="quote-price muted">Price not reported</strong>}
          <div className="quote-changes">
            <Change value={token.change24hPct} label="24h" />
            <Change value={token.change7dPct} label="7d" />
            {marketCap ? <span className="hero-change"><small>Mcap</small><b>{marketCap}</b></span> : null}
          </div>
        </div>
      </header>

      <nav className="section-nav" aria-label="Profile sections">
        {model.sections.map((section) => <a key={section.id} href={`#${section.id}`} aria-current={activeSection === section.id ? "location" : undefined} onClick={() => { setActiveSection(section.id); if (section.id === "sources") setSourcesOpen(true); }}>{section.label}</a>)}
      </nav>

      <section className="profile-section" id="market" aria-labelledby="market-title">
        <SectionHead eyebrow="Token" title="Market snapshot" id="market-title" />
        {model.snapshot.pairs.length > 0 ? (
          <div className="snapshot-pairs">
            {model.snapshot.pairs.map((pair) => (
              <div key={pair.id} className="snapshot-pair">
                <Tile item={pair.main} emphasis />
                {pair.change ? <Tile item={pair.change} /> : null}
              </div>
            ))}
          </div>
        ) : <p className="muted-copy">No token-level market figures are stored for this token.</p>}
      </section>

      {fundamentals.available ? (
        <section className="profile-section" id="fundamentals" aria-labelledby="fundamentals-title">
          <SectionHead eyebrow="Associated protocol" title="Fundamentals" id="fundamentals-title" />
          <div className="scope-banner">
            <p>Associated protocol: <strong>{fundamentals.protocolName}</strong></p>
            <p>{fundamentals.scopeLine}</p>
          </div>
          {fundamentals.primary.length > 0 ? <div className="tile-grid">{fundamentals.primary.map((item) => <Tile key={item.id} item={item} emphasis />)}</div> : null}
          <div className="split-lists">
            <MetricList title="Valuation" items={fundamentals.valuation} />
            <MetricList title="Changes" items={fundamentals.changes} />
          </div>
        </section>
      ) : null}

      {tokenomics.available ? (
        <section className="profile-section" id="tokenomics" aria-labelledby="tokenomics-title">
          <SectionHead eyebrow="Token supply" title="Tokenomics" id="tokenomics-title" />
          <div className="tile-grid tile-grid-3">{tokenomics.items.map((item) => <Tile key={item.id} item={item} />)}</div>
          {tokenomics.composition ? (
            <div className="supply-composition" role="group" aria-labelledby="supply-composition-title">
              <div className="supply-comp-top">
                <div className="supply-comp-lead">
                  <p className="supply-comp-label" id="supply-composition-title">Circulating supply</p>
                  <strong className="supply-comp-pct">{tokenomics.composition.circulatingPct.toFixed(1)}%</strong>
                  <p className="supply-comp-caption">of maximum supply is circulating</p>
                </div>
                <div className="supply-comp-figures">
                  <div><strong>{tokenomics.composition.circulating} <small>{tokenomics.composition.symbol}</small></strong><span>Circulating</span></div>
                  <div><strong>{tokenomics.composition.maximum} <small>{tokenomics.composition.symbol}</small></strong><span>Maximum supply</span></div>
                </div>
              </div>
              <div
                className="supply-comp-track"
                role="img"
                aria-label={`${tokenomics.composition.circulatingPct.toFixed(1)}% circulating, ${tokenomics.composition.remainingPct.toFixed(1)}% remaining`}
              >
                <span style={{ width: `${tokenomics.composition.barPct}%` }} />
              </div>
              <p className="supply-comp-split">
                <b>{tokenomics.composition.circulatingPct.toFixed(1)}%</b> circulating <span aria-hidden="true">·</span> {tokenomics.composition.remainingPct.toFixed(1)}% remaining
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {history.available ? (
        <section className="profile-section" id="history" aria-labelledby="history-title">
          <SectionHead eyebrow="Token performance" title="Market history" id="history-title" />
          {history.series.length > 0 ? <HistoryCharts data={data.history} series={history.series} label="Market history" /> : null}
          {history.tvl ? (
            <div className="subsection">
              <h3>Associated Protocol TVL<small>{fundamentals.available ? fundamentals.protocolName : "Protocol scope"}</small></h3>
              <HistoryCharts data={data.history} series={["tvlUsd"]} label="TVL history" />
            </div>
          ) : null}
        </section>
      ) : null}

      {marketStructure.available ? (
        <section className="profile-section" id="market-structure" aria-labelledby="structure-title">
          <SectionHead eyebrow="On-chain DEX markets" title="Trading &amp; Liquidity" id="structure-title" />
          <p className="scope-line">{marketStructure.scopeLine}</p>
          <div className="tile-grid tile-grid-3">{marketStructure.cards.map((item) => <Tile key={item.id} item={item} />)}</div>
        </section>
      ) : null}

      {dexMarkets.available ? (
        <section className="profile-section" id="dex-markets" aria-labelledby="dex-markets-title">
          <SectionHead eyebrow="On-chain DEX pools" title="DEX Markets" id="dex-markets-title" />
          <p className="scope-line">{dexMarkets.scopeLine}</p>
          {dexMarkets.cards.length > 0 ? <div className="tile-grid tile-grid-3">{dexMarkets.cards.map((item) => <Tile key={item.id} item={item} />)}</div> : null}
          {dexMarkets.dexes.length > 0 ? (
            <p className="scope-line">DEXs: {dexMarkets.dexes.map((dex) => <span key={dex} className="chip chip-quiet">{dex}</span>)}</p>
          ) : null}
          <PoolList pools={dexMarkets.pools} />
        </section>
      ) : null}

      {onchainIdentity.available ? (
        <section className="profile-section" id="onchain-identity" aria-labelledby="onchain-identity-title">
          <SectionHead eyebrow="On-chain identity" title="Contract / On-chain Identity" id="onchain-identity-title" />
          <div className="metric-list">
            <dl>
              <div className="metric-row">
                <dt>Network</dt>
                <dd>{onchainIdentity.network}</dd>
              </div>
              <div className="metric-row">
                <dt>Contract address</dt>
                <dd className="address"><code title={onchainIdentity.contractAddress}>{shortAddress(onchainIdentity.contractAddress)}</code><CopyButton value={onchainIdentity.contractAddress} label="contract address" /></dd>
              </div>
            </dl>
          </div>
        </section>
      ) : null}

      {technical.length > 0 || hasCrossMetric ? (
        <section className="profile-section" id="technical" aria-labelledby="technical-title">
          <SectionHead eyebrow="Token analysis" title="Technical indicators" id="technical-title" />
          {data.technicalIndicators && technical.length > 0 ? <TechnicalIndicators view={data.technicalIndicators} groups={technical} /> : null}
          {hasCrossMetric ? (
            <div className="cross-metric" id="cross-metric" aria-labelledby="cross-metric-title">
              <header className="cross-metric-head">
                <p className="eyebrow">Token dynamics</p>
                <h3 id="cross-metric-title">Cross-metric analysis</h3>
                <p className="scope-line">How price, volume, market cap and protocol data move relative to each other. Neutral observations, not trading signals.</p>
              </header>
              {divergence.indicators.length > 0 ? (
                <div className="indicator-grid">{divergence.indicators.map((indicator) => <IndicatorCard key={indicator.id} indicator={indicator} />)}</div>
              ) : null}
              {divergence.comparisons.length > 0 ? (
                <div className="split-lists"><MetricList title="Comparisons · 24h" items={divergence.comparisons} /></div>
              ) : null}
              <Signals items={divergence.signals} title={`Divergence flags · ${divergence.signalsHorizon ?? "24h"}`} />
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="profile-section analysis-section" id="analysis" aria-label="Deep AI Analysis">
        <DeepAnalysisPanel tokenId={token.id} payload={payload} autoGenerateSignal={autoGenerateSignal} onBackToOverview={() => reveal("overview")} />
      </section>

      <SourcesMethodology
        methodology={model.methodology}
        open={sourcesOpen}
        onToggle={setSourcesOpen}
      />

      <PageFooter />
    </div>
  );
}
