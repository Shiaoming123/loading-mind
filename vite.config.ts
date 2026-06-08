import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { agentRuntimePlugin } from "./server/agentServer.mjs";

export default defineConfig({
  plugins: [agentRuntimePlugin(), react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts"
  }
});
