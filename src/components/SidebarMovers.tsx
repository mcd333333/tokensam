import Link from "next/link";
import { TokenLogo } from "@/components/TokenLogo";
import { formatChange } from "@/lib/ui/format";
import { formatVolumeCompact, type Mover, type Movers, type VolumeRank } from "@/lib/ui/movers";

/** Typographic minus for display; the underlying value is unchanged. */
function changeText(value: number): string {
  return (formatChange(value)?.text ?? "").replace(/^-/, "−");
}

function MoverList({ label, movers, direction }: { label: string; movers: Mover[]; direction: "up" | "down" }) {
  if (movers.length === 0) return null;
  const verb = direction === "up" ? "up" : "down";
  return (
    <div className="movers-group">
      <span className="movers-label" id={`movers-${direction}`}>{label}</span>
      <ol className="movers-list" aria-labelledby={`movers-${direction}`}>
        {movers.map((mover) => (
          <li key={mover.id}>
            <Link
              className="mover-row"
              href={`/tokens/${mover.id}`}
              prefetch={false}
              title={mover.name}
              aria-label={`${mover.name} (${mover.symbol}), ${verb} ${changeText(Math.abs(mover.change24hPct)).replace(/^\+/, "")} over 24 hours`}
            >
              <TokenLogo src={mover.logoUrl} symbol={mover.symbol} size={18} />
              <span className="mover-symbol">{mover.symbol}</span>
              <span className={`mover-change mover-${direction}`}>
                <span className="mover-arrow" aria-hidden="true">{direction === "up" ? "↑" : "↓"}</span>
                {changeText(mover.change24hPct)}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Volume rankings: neutral typography (active/inactive describes volume, not performance). */
function VolumeList({ label, id, rows }: { label: string; id: string; rows: VolumeRank[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="movers-group">
      <span className="movers-label" id={id}>{label}</span>
      <ol className="movers-list" aria-labelledby={id}>
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              className="mover-row"
              href={`/tokens/${row.id}`}
              prefetch={false}
              title={row.name}
              aria-label={`${row.name} (${row.symbol}), ${formatVolumeCompact(row.volume24hUsd)} traded over 24 hours`}
            >
              <TokenLogo src={row.logoUrl} symbol={row.symbol} size={18} />
              <span className="mover-symbol">{row.symbol}</span>
              <span className="mover-change mover-volume">{formatVolumeCompact(row.volume24hUsd)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Sidebar market panel for the tracked universe: largest stored 24-hour price
 * changes, then highest and lowest stored 24-hour volumes. Each row opens the
 * Token Profile; an empty ranking or section is simply not rendered.
 */
export function SidebarMovers({ movers }: { movers: Movers }) {
  const hasMovers = movers.gainers.length + movers.losers.length > 0;
  const hasVolume = movers.active.length + movers.inactive.length > 0;
  if (!hasMovers && !hasVolume) return null;
  return (
    <>
      {hasMovers ? (
        <section className="sidebar-movers" aria-labelledby="movers-heading">
          <h2 className="nav-label movers-heading" id="movers-heading">24H Movers</h2>
          <MoverList label="Top gainers" movers={movers.gainers} direction="up" />
          <MoverList label="Top losers" movers={movers.losers} direction="down" />
        </section>
      ) : null}
      {hasVolume ? (
        <section className="sidebar-movers" aria-labelledby="active-heading">
          <h2 className="nav-label movers-heading" id="active-heading">24H Active</h2>
          <VolumeList label="Top active" id="volume-active" rows={movers.active} />
          <VolumeList label="Top inactive" id="volume-inactive" rows={movers.inactive} />
        </section>
      ) : null}
    </>
  );
}
