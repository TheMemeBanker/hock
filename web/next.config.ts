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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
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
