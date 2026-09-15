import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      "@next/next/no-html-link-for-pages": "off"
    }
  },
  {
    files: ["apps/api/**/*.ts", "packages/shared/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  },
  globalIgnores([
    "**/dist/**",
    "**/.next/**",
    "**/node_modules/**",
    "**/next-env.d.ts",
    "**/*.tsbuildinfo"
  ])
]);
