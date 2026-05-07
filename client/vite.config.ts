import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the Travel Album frontend.
// Backend API URL / proxy settings will be added when the API contract lands
// (P1.T3 onwards). For now this config only enables React + JSX transform.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
});
