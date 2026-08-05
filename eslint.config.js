// Flat ESLint config covering both workspaces: the React frontend in src/ and
// the Node backend in backend/src/.
//
// Deliberately started at the non-type-aware `recommended` tier rather than
// `recommendedTypeChecked`. This is the first linter this repo has ever had, and
// a config that reports hundreds of findings on day one is a config everyone
// learns to ignore -- the useful state is a green baseline that fails CI on new
// problems. `tsc --noEmit` already runs in CI and covers most of what the
// type-aware tier would add. Ratcheting up is a deliberate follow-up, not a
// thing to sneak in here.
//
// Rules turned off below are turned off because they fight this codebase's
// existing, intentional conventions -- each one says why. Everything else is
// left on, including the handful that currently need inline suppressions.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    // Build output, deps, generated state, and the workflow JSON payloads.
    ignores: [
      "dist/**",
      "backend/dist/**",
      ".e2e-dist/**",
      "backend/.e2e-dist/**",
      "playwright-report/**",
      "test-results/**",
      "backend/data/**",
      "node_modules/**",
      "**/node_modules/**",
      "workflow/**",
      "eslint.config.js",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    rules: {
      // The codebase uses `catch {}` and `_`-prefixed params to say "this value
      // is deliberately unused" -- honour that spelling instead of flagging it.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // Filename sanitisation deliberately matches the U+0000 to U+001F range to
      // strip control characters out of user-supplied names before they reach the
      // filesystem. The rule cannot tell that apart from a stray control char.
      "no-control-regex": "off",
      // Warn, not error: there are 84 of these today, almost all at boundaries
      // where the shape genuinely is unknown (Comfy workflow JSON, RunPod
      // responses). Failing the build on them would mean either a large typing
      // project bolted onto this change or 84 inline suppressions. Left visible
      // so the count can be driven down deliberately.
      "@typescript-eslint/no-explicit-any": "warn",
      // Backend modules keep module-level mutable state (job queue, auth cache)
      // by design; `let` at module scope is not a smell here.
      "prefer-const": ["error", { destructuring: "all" }],
      // Flags real mistakes (`if (x = 1)`) without complaining about the
      // intentional assignment-in-condition idiom this repo does not use anyway.
      "no-cond-assign": ["error", "always"],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "object-shorthand": ["error", "properties"],
    },
  },

  {
    // TypeScript resolves identifiers itself and reports unknown ones with far
    // better messages, so `no-undef` on TS files is pure duplicate noise -- this
    // is typescript-eslint's own standing recommendation.
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: { "no-undef": "off" },
  },

  // --- Frontend -----------------------------------------------------------
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Warn, not error: App.tsx has large effects whose dependency lists were
      // tuned by hand, and turning those into build failures now would force
      // either a risky refactor or a wall of suppressions. Surfacing them is
      // the point; blocking on them is not.
      "react-hooks/exhaustive-deps": "warn",
      // Same reasoning, and the same follow-up: 12 effects currently set state
      // synchronously. Each one is a small "derive it instead of storing it"
      // refactor in a component that has no test coverage yet, so these are
      // recorded rather than enforced until the frontend has tests.
      "react-hooks/set-state-in-effect": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // --- Node: backend, config files, and the one-off maintenance scripts ----
  {
    files: ["backend/**/*.{ts,cjs,mjs}", "e2e/**/*.{ts,cjs,mjs}", "vite.config.ts", "*.config.{js,cjs,mjs}"],
    languageOptions: {
      globals: globals.node,
      sourceType: "module",
    },
    rules: {
      // The backend logs to stdout on purpose; pm2 captures it.
      "no-console": "off",
    },
  },

  {
    files: ["public/**/*.js"],
    languageOptions: { globals: globals.browser },
  },

  {
    // pm2 reads this with require(), so it is genuinely CommonJS.
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },

  // --- Tests --------------------------------------------------------------
  {
    files: ["**/*.test.ts", "**/*.integration.test.ts"],
    rules: {
      // Tests reach into module internals and build deliberately malformed
      // fixtures to prove the guards hold.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
