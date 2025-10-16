import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: true,
    target: "node18",
    outDir: "dist",
    rollupOptions: {
      input: "src/index.ts",
    },
  },
});
