"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import type { LiveTokenProfileData } from "@/types/token";
import type { RootDataProfile } from "@/lib/data/rootdata-profiles";
import { buildProfileModel, type Card, type DexGroupRow, type ExchangeRow, type PairLine, type PoolRow } from "@/lib/ui/profile-model";
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

function SectionHead({ eyebrow, title, id, children }: { eyebrow?: string; title: string; id: string; children?: ReactNode }) {
  return (
    <header className="section-head">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
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

/** Hover (and keyboard focus) card listing a venue's trading pairs. Renders nothing when no pairs are known. */
function PairCard({ title, lines }: { title: string; lines: PairLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="pair-card" role="tooltip">
      <span className="pair-card-title">{title}</span>
      <ul>
        {lines.map((line, index) => (
          <li key={`${line.pair}-${index}`}><span>{line.pair}</span>{line.figure ? <b>{line.figure}</b> : null}</li>
        ))}
      </ul>
    </div>
  );
}

/** Compact boxes, one per DEX: combined liquidity and 24h volume of its pools for this token, and its share of liquidity. */
function DexGroupGrid({ groups }: { groups: DexGroupRow[] }) {
  return (
    <ul className="exchange-grid">
      {groups.map((group) => (
        <li key={group.id} className="exchange-box" tabIndex={group.pairLines.length > 0 ? 0 : undefined}>
          <PairCard title={`${group.label} · top pairs`} lines={group.pairLines} />
          <span className="exchange-head">
            <TokenLogo src={group.logo} symbol={group.label} size={22} />
            <span className="exchange-name">{group.label}</span>
          </span>
          <b className="exchange-volume">{group.liquidity ?? "—"}<small> pool liquidity</small></b>
          <span className="exchange-meta">
            {group.volume24h ? `${group.volume24h} vol · 24h · ` : ""}{group.sharePct >= 0.1 ? `${group.sharePct.toFixed(1)}%` : "<0.1%"} · {group.pools} {group.pools === 1 ? "pool" : "pools"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Compact boxes, one per exchange: logo, name, 24h volume, its share of the listed total and pair count. */
function ExchangeList({ rows }: { rows: ExchangeRow[] }) {
  return (
    <ul className="exchange-grid">
      {rows.map((row) => (
        <li key={row.id} className="exchange-box" tabIndex={row.pairLines.length > 0 ? 0 : undefined}>
          <PairCard title={`${row.name} · top pairs by volume`} lines={row.pairLines} />
          <span className="exchange-head">
            <TokenLogo src={row.logo} symbol={row.name} size={22} />
            <span className="exchange-name">{row.name}</span>
          </span>
          <b className="exchange-volume">{row.volume24h}</b>
          <span className="exchange-meta">
            {row.sharePct >= 0.1 ? `${row.sharePct.toFixed(1)}%` : "<0.1%"} · {row.pairs} {row.pairs === 1 ? "pair" : "pairs"}
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

// Brand glyphs from Bootstrap Icons (MIT).
const projectPlatforms = [
  { keys: ["website"], label: "Official website", icon: null },
  { keys: ["x", "twitter"], label: "X / Twitter", icon: "M12.6.75h2.454l-5.36 6.142L16 15.25h-4.937l-3.867-5.07-4.425 5.07H.316l5.733-6.57L0 .75h5.063l3.495 4.633L12.601.75Zm-.86 13.028h1.36L4.323 2.145H2.865z" },
  { keys: ["github"], label: "GitHub", icon: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" },
  { keys: ["medium"], label: "Medium", icon: "M9.025 8c0 2.485-2.02 4.5-4.513 4.5A4.506 4.506 0 0 1 0 8c0-2.486 2.02-4.5 4.512-4.5A4.506 4.506 0 0 1 9.025 8m4.95 0c0 2.34-1.01 4.236-2.256 4.236S9.463 10.339 9.463 8c0-2.34 1.01-4.236 2.256-4.236S13.975 5.661 13.975 8M16 8c0 2.096-.355 3.795-.794 3.795-.438 0-.793-1.7-.793-3.795 0-2.096.355-3.795.794-3.795.438 0 .793 1.699.793 3.795" },
  { keys: ["linkedin"], label: "LinkedIn", icon: "M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 0 16 .513 16 1.146v13.708c0 .633-.526 1.146-1.175 1.146H1.175C.526 16 0 15.487 0 14.854zm4.943 12.248V6.169H2.542v7.225zm-1.2-8.212c.837 0 1.358-.554 1.358-1.248-.015-.709-.52-1.248-1.342-1.248S2.4 3.226 2.4 3.934c0 .694.521 1.248 1.327 1.248zm4.908 8.212V9.359c0-.216.016-.432.08-.586.173-.431.568-.878 1.232-.878.869 0 1.216.662 1.216 1.634v3.865h2.401V9.25c0-2.22-1.184-3.252-2.764-3.252-1.274 0-1.845.7-2.165 1.193v.025h-.016l.016-.025V6.169h-2.4c.03.678 0 7.225 0 7.225z" },
];

function safeExternalUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function ProjectLinks({ profile }: { profile: RootDataProfile }) {
  const addresses = new Map<string, string>();
  const add = (key: unknown, value: unknown) => {
    if (typeof key !== "string") return;
    const url = safeExternalUrl(value);
    if (url) addresses.set(key.trim().toLowerCase(), url.href);
  };

  if (Array.isArray(profile.social_media)) {
    for (const item of profile.social_media) {
      if (!item || typeof item !== "object") continue;
      const { type, name, url, link } = item as { type?: unknown; name?: unknown; url?: unknown; link?: unknown };
      add(type || name, url || link);
    }
  } else if (profile.social_media && typeof profile.social_media === "object") {
    for (const [key, value] of Object.entries(profile.social_media)) add(key, value);
  }
  add("website", profile.website_url);

  const links = projectPlatforms.flatMap((platform) => {
    const href = platform.keys.map((key) => addresses.get(key)).find(Boolean);
    return href ? [{ ...platform, href }] : [];
  });
  if (links.length === 0) return null;

  return (
    <nav className="project-links" aria-label="Official project links">
      {links.map(({ label, href, icon }) => (
        <a key={label} href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={label}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {icon ? <path fill="currentColor" d={icon} /> : (
              <g fill="none" stroke="currentColor" strokeWidth="1.25">
                <circle cx="8" cy="8" r="7" />
                <ellipse cx="8" cy="8" rx="3" ry="7" />
                <path d="M1 8h14" />
              </g>
            )}
          </svg>
        </a>
      ))}
    </nav>
  );
}

const fundraisingDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function reportedUsd(value: unknown): string | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? fundraisingDollars.format(amount) : null;
}

type ProjectInvestor = { name: string; logo: string | null; contribution: string | null };

function InvestorGrid({ investors }: { investors: ProjectInvestor[] }) {
  return (
    <ul className="exchange-grid project-investor-grid">
      {investors.map(({ name, logo, contribution }) => (
        <li key={name} className="exchange-box">
          <span className="exchange-head">
            <TokenLogo src={logo} symbol={name} size={22} />
            <span className="exchange-name">{name}</span>
          </span>
          {contribution !== null ? <b className="exchange-volume">{contribution}<small> invested</small></b> : null}
        </li>
      ))}
    </ul>
  );
}

function RootDataSection({ profile }: { profile: RootDataProfile }) {
  const investorsByName = new Map<string, ProjectInvestor>();
  if (Array.isArray(profile.investors)) {
    for (const item of profile.investors) {
      if (!item || typeof item !== "object") continue;
      const { name, logo, contribution_usd } = item as { name?: unknown; logo?: unknown; contribution_usd?: unknown };
      if (typeof name !== "string" || !name.trim()) continue;
      const displayName = name.trim();
      const key = displayName.toLowerCase();
      const previous = investorsByName.get(key);
      const image = safeExternalUrl(logo);
      const logoUrl = image?.protocol === "https:" && image.hostname.endsWith(".rootdata.com") ? image.href : null;
      investorsByName.set(key, {
        name: previous?.name ?? displayName,
        logo: previous?.logo ?? logoUrl,
        contribution: previous?.contribution ?? reportedUsd(contribution_usd),
      });
    }
  }

  const investors = [...investorsByName.values()];
  const funding = reportedUsd(profile.total_funding);
  const additionalFunding = profile.additionalFunding;

  return (
    <section className="profile-section rootdata-section" id="rootdata" aria-labelledby="rootdata-title">
      <SectionHead title="Corporate Profile" id="rootdata-title" />
      {profile.one_liner ? <p className="rootdata-one-liner">{profile.one_liner}</p> : null}
      {profile.description ? <p className="rootdata-description">{profile.description}</p> : null}
      <div className="project-funding">
        {investors.length > 0 ? (
          <section aria-labelledby="project-investors-title">
            <h3 id="project-investors-title">{additionalFunding?.investorLabel ?? "Investors"}</h3>
            <InvestorGrid investors={investors.slice(0, 12)} />
            {investors.length > 12 ? (
              <details className="pool-details">
                <summary>More investors ({investors.length - 12})</summary>
                <InvestorGrid investors={investors.slice(12)} />
              </details>
            ) : null}
          </section>
        ) : null}
        <dl className="project-funding-total">
          <dt>{additionalFunding?.label ?? "Total fundraising"}</dt>
          <dd>{funding ? (additionalFunding?.lowerBound ? "More than " + funding : funding) : "Undisclosed"}</dd>
        </dl>
        {additionalFunding ? (
          <p className="rootdata-description">
            {additionalFunding.note}{" "}
            <a href={additionalFunding.profileUrl} target="_blank" rel="noopener noreferrer">CryptoRank profile</a>
            {" · "}
            <a href={additionalFunding.amountUrl} target="_blank" rel="noopener noreferrer">Funding source</a>
            {additionalFunding.investorUrl && additionalFunding.investorUrl !== additionalFunding.amountUrl ? (
              <>{" · "}<a href={additionalFunding.investorUrl} target="_blank" rel="noopener noreferrer">Investor source</a></>
            ) : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function TokenProfile({ data, rootdataProfile }: { data: LiveTokenProfileData; rootdataProfile: RootDataProfile | null }) {
  const { token } = data;
  const labelKey = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();
  const headerLabels = new Set([token.chain, token.category, data.isNative ? "Native asset" : ""].map(labelKey));
  const projectTags = (Array.isArray(rootdataProfile?.tags) ? rootdataProfile.tags : []).flatMap((tag) => {
    if (typeof tag !== "string") return [];
    const key = labelKey(tag);
    if (headerLabels.has(key)) return [];
    headerLabels.add(key);
    return [tag.trim()];
  });
  const model = useMemo(() => buildProfileModel(data), [data]);
  const navSections = useMemo(
    () => rootdataProfile ? [{ id: "rootdata", label: "Project" }, ...model.sections] : model.sections,
    [model.sections, rootdataProfile],
  );
  const payload = useMemo(() => buildProfilePayload(data), [data]);
  const copyData = useMemo(() => formatProfilePayloadText(payload), [payload]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("overview");
  useEffect(() => {
    const sections = navSections.map((section) => document.getElementById(section.id))
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
  }, [navSections]);
  // Clicking the header's AI research report button scrolls to the report section
  // and starts generation there; incrementing this counter is the signal DeepAnalysisPanel watches
  // (see its own useEffect) to start a fresh generation even if one is already showing.
  const [autoGenerateSignal, setAutoGenerateSignal] = useState(0);
  const price = formatUsd(token.priceUsd);
  const marketCap = formatUsd(token.marketCapUsd, true);
  // Sections without data are simply omitted (page and nav); no "not available" cards are rendered.
  const { fundamentals, marketStructure, dexMarkets, exchanges, onchainIdentity, tokenomics, history, technical, divergence } = model;
  const hasCrossMetric = divergence.comparisons.length + divergence.signals.length + divergence.indicators.length > 0;

  const reveal = (id: string) => window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }));
  const openAnalysis = () => { setAutoGenerateSignal((signal) => signal + 1); reveal("analysis"); };

  return (
    <div className="page profile-page">
      <div className="profile-top-bar">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/">Research Universe</Link><span aria-hidden="true">/</span><span aria-current="page">{token.name}</span>
        </nav>
        <CopyButton value={copyData} label="token data shown on this page" text="Copy data" />
      </div>

      <header className="profile-header" id="overview">
        <div className="profile-identity">
          <TokenLogo src={data.logoUrl} symbol={token.symbol} size={52} />
          <div className="identity-copy">
            <p className="profile-kicker">Token research</p>
            <h1>{token.name} <span className="symbol">{token.symbol}</span></h1>
            <div className="identity-meta">
              <span>{token.chain}</span>
              <span className="chip">{token.category}</span>
              {projectTags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
              {data.isNative ? <span className="native-tag">Native asset</span> : data.contractAddress ? (
                <span className="address"><code title={data.contractAddress}>{shortAddress(data.contractAddress)}</code><CopyButton value={data.contractAddress} label="contract address" /></span>
              ) : null}
            </div>
            {rootdataProfile ? <ProjectLinks profile={rootdataProfile} /> : null}
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
        {navSections.map((section) => <a key={section.id} href={`#${section.id}`} aria-current={activeSection === section.id ? "location" : undefined} onClick={() => { setActiveSection(section.id); if (section.id === "sources") setSourcesOpen(true); }}>{section.label}</a>)}
      </nav>

      {rootdataProfile ? <RootDataSection profile={rootdataProfile} /> : null}

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
          {dexMarkets.groups.length > 0 ? (
            <div>
              <h3>Decentralised exchanges<small>{dexMarkets.groups.length} shown · across the {dexMarkets.groupedPools} most liquid pools</small></h3>
              <DexGroupGrid groups={dexMarkets.groups} />
              <p className="scope-line">Pool figures are each pool&apos;s total value locked and trading volume, counting both sides of every pair, so they can differ from the token-side totals above.</p>
            </div>
          ) : null}
          {dexMarkets.pools.length > 0 ? (
            <details className="pool-details">
              <summary>Individual pools ({dexMarkets.pools.length}{dexMarkets.morePools > 0 ? ` of ${dexMarkets.groupedPools}` : ""})</summary>
              <PoolList pools={dexMarkets.pools} />
              {dexMarkets.morePools > 0 ? <p className="scope-line">+ {dexMarkets.morePools} more pools with smaller liquidity, included in the DEX boxes above.</p> : null}
            </details>
          ) : null}
        </section>
      ) : null}

      {exchanges.available ? (
        <section className="profile-section" id="exchanges" aria-labelledby="exchanges-title">
          <SectionHead eyebrow={exchanges.eyebrow} title="Exchanges" id="exchanges-title" />
          <p className="scope-line">{exchanges.scopeLine}</p>
          {exchanges.groups.map((group) => (
            <div key={group.kind}>
              <h3>{group.title}{group.total ? <small>{group.rows.length} largest · {group.total} · 24h</small> : null}</h3>
              <ExchangeList rows={group.rows} />
            </div>
          ))}
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
        corporateProfileSource={safeExternalUrl(rootdataProfile?.rootdata_url)?.href}
        open={sourcesOpen}
        onToggle={setSourcesOpen}
      />

      <PageFooter />
    </div>
  );
}
