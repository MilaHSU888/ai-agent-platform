import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "offline-dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    codeSplitting: false,
    rollupOptions: {
      input: "offline.html",
    },
  },
});
