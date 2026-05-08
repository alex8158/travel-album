import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the Travel Album frontend.
//
// /api proxy (P1.T4): the dev server forwards every /api/* request to
// the backend dev server. The default backend port is 3000 (see
// .env.example PORT); override here if you run the backend elsewhere.
// In production the SPA and API are expected to share an origin, so
// the proxy is a dev-only construct.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
