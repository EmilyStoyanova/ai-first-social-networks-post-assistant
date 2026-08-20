import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Not part of this app. text-worker/ holds the CommonJS + Python halves that are
    // copied onto the Mac text worker and run in ITS runtime, under its own rules —
    // linting them with the Next.js/ESM ruleset only reports that CommonJS is CommonJS.
    "text-worker/**",
  ]),
  {
    rules: {
      // Allow unused function parameters prefixed with _ (intentionally unused).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
]);

export default eslintConfig;
