import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://hock.fun";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: "HOCK — Launch it. Hock it.", template: "%s — HOCK" },
  description:
    "A Solana launchpad with built-in lending. Every coin launched on HOCK is born collateral: launch in one signature, clear the gate, borrow SOL against it. Non-custodial, in-vault.",
  icons: {
    icon: [
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/favicon-64.png", sizes: "64x64", type: "image/png" },
      { url: "/brand/hock-mark.svg", type: "image/svg+xml" },
    ],
    apple: "/brand/apple-touch-icon.png",
  },
  openGraph: {
    title: "HOCK — Launch it. Hock it.",
    description: "Launch a coin, clear the gate, borrow SOL against it. Non-custodial, in-vault.",
    siteName: "HOCK",
    type: "website",
    url: SITE,
    images: [{ url: "/brand/hock-og-1200x630.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@HockFinance",
    creator: "@HockFinance",
    title: "HOCK — Launch it. Hock it.",
    description: "Launch a coin, clear the gate, borrow SOL against it. Non-custodial, in-vault.",
    images: ["/brand/hock-og-1200x630.png"],
  },
};

export const viewport: Viewport = { themeColor: "#080B10", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
