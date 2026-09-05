/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@examguard/ui', '@examguard/types', '@examguard/auth', '@examguard/config'],
  reactStrictMode: true,
  // Standalone output needs symlink privileges on Windows dev machines;
  // enable it explicitly in Docker/CI where it is supported.
  output: process.env.NEXT_STANDALONE === '1' ? 'standalone' : undefined,
};

export default nextConfig;