import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const basePath = (() => {
  const value = process.env.BASE_PATH;
  if (!value) {
    return "/";
  }

  return value.endsWith("/") ? value : `${value}/`;
})();

export default defineConfig({
  base: basePath,
  plugins: [react()],
});
