import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const inter = localFont({ src: "./fonts/inter-latin-wght-normal.woff2", variable: "--font-inter", display: "swap", weight: "100 900" });
// Display face echoing the emblem's inscriptional capitals; used for headings only.
const cinzel = localFont({ src: "./fonts/cinzel-latin-wght-normal.woff2", variable: "--font-cinzel", display: "swap", weight: "400 900" });

export const metadata: Metadata = {
  title: { default: "Token Samurai · Crypto Research", template: "%s · Token Samurai" },
  description: "Token Samurai — AI-powered crypto market intelligence and fundamentals research. Cut through the noise. Find the signal.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${cinzel.variable}`}>
      <body>{children}</body>
    </html>
  );
}
