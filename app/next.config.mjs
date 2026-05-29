/** @type {import('next').NextConfig} */
const nextConfig = {
  // Explicit even though Next 14 defaults this to true — the value
  // moves around across versions and we want the doubled-render
  // behaviour locked on regardless of what the framework default
  // shifts to later.
  reactStrictMode: true,

  // The backend lives on a different domain (api.ghwcrm.com) and
  // is fully CORS-configured server-side; we do NOT rewrite or
  // proxy through Next. Frontend hits the absolute URL via
  // NEXT_PUBLIC_BACKEND_URL. This keeps Vercel's edge from
  // re-handling auth/cookies between us and Render.
};

export default nextConfig;
