import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // Old enough for the system WebView on early Android 12 builds.
  build: { target: "chrome89", cssTarget: "chrome89", chunkSizeWarningLimit: 1500 },
});
