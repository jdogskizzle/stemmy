import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Serve under a sub-path (e.g. "/stemmy/") when behind a path-based reverse proxy.
  base: `${(process.env.STEMMY_BASE_PATH ?? "").replace(/\/+$/, "")}/`,
  plugins: [react()],
  server: {
    host: true,
    proxy: { "/api": process.env.STEMMY_API ?? "http://localhost:8000" },
  },
});
