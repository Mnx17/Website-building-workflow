import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `postgres` is a native-ish driver; keep it out of the bundler's reach so
  // Route Handlers get the real Node module.
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
