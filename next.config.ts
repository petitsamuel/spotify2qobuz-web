import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // Instrumentation hook is enabled by default in Next.js 14+
  // The src/instrumentation.ts file runs on server startup
};

export default nextConfig;
