// defineConfig se importa de "vitest/config" (no de "vite") para que el
// campo `test` typechequee: la versión instalada de vite no lo declara.
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Bundle IIFE: el cliente lo carga con un <script> y llama window.CraftechChat.
  build: {
    lib: { entry: "src/index.ts", name: "CraftechChat", formats: ["iife"], fileName: () => "widget.js" },
  },
  test: { environment: "happy-dom" },
});
