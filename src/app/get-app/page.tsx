import type { Metadata } from "next";
import Link from "next/link";
import { AppShell, PageFooter } from "@/components/AppShell";
import { getAppInstallLinks } from "@/lib/ui/app-install-links";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Get the app",
  description: "Get Token Samurai for Android or iPhone.",
};

export default function GetAppPage() {
  const { android, ios } = getAppInstallLinks();
  const platforms = [
    { name: "Android", url: android },
    { name: "iPhone", url: ios },
  ];

  return (
    <AppShell active="none">
      <div className="page">
        <section className={styles.hero} aria-labelledby="get-app-title">
          <div className={styles.heading}>
            <h1 id="get-app-title">Get the app</h1>
            <p>Track live token prices and keep your watchlist on your phone.</p>
          </div>
        </section>
        <div className={styles.platforms}>
          {platforms.map(({ name, url }) => (
            <section className={styles.platform} key={name}>
              <h2>{name}</h2>
              {url ? (
                <a className={styles.install} href={url}>
                  Get the app for {name} <span aria-hidden="true">↗</span>
                </a>
              ) : <p>Installation is unavailable for this platform.</p>}
            </section>
          ))}
        </div>
        <Link className={styles.dashboard} href="/">Open the web dashboard</Link>
        <PageFooter />
      </div>
    </AppShell>
  );
}
