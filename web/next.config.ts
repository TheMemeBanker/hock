import type { NextConfig } from "next";

const csp = [
  "default-src 'self'",
  // React's development build needs eval for its debugging features; production never gets it.
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  `connect-src 'self' https://pumpportal.fun wss://pumpportal.fun https://api.dexscreener.com https://api.jup.ag https://node1.irys.xyz https://node2.irys.xyz https://uploader.irys.xyz https://*.irys.xyz https://arweave.net https://gateway.irys.xyz https://ipfs.filebase.io https://ipfs.4everland.io https://pump.mypinata.cloud${process.env.NEXT_PUBLIC_COSIGN_URL ? " " + new URL(process.env.NEXT_PUBLIC_COSIGN_URL).origin : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// STATIC_EXPORT=1 builds the cosmetic/static copy of the site (GitHub Pages): no API routes, no server reads,
// optional basePath for a project-page preview URL. Security headers come from the host in that mode.
const STATIC = process.env.STATIC_EXPORT === "1";
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(STATIC ? { output: "export" as const, trailingSlash: true, basePath: BASE, assetPrefix: BASE || undefined, images: { unoptimized: true } } : {}),
  async headers() {
    if (STATIC) return [];
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
