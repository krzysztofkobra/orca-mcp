import { defineConfig } from "vitest/config";

// plugin/ has its own tests, run by `orca plugin test plugin` against Orca's own `orca/testing`.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
