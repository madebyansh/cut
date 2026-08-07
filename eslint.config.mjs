import eslint from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  eslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module" },
      globals: {
        Buffer: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        Blob: "readonly",
        FormData: "readonly",
        NodeRequire: "readonly",
        NodeJS: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        queueMicrotask: "readonly",
        require: "readonly",
        setImmediate: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        structuredClone: "readonly"
      }
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-async-promise-executor": "off",
      "no-control-regex": "off",
      "no-redeclare": "off",
      "no-regex-spaces": "off",
      "no-unsafe-finally": "off",
      "no-useless-escape": "off"
    }
  },
  {
    files: ["**/*.mjs", "editors/vscode/**/*.js"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        console: "readonly",
        process: "readonly",
        queueMicrotask: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        structuredClone: "readonly"
      }
    }
  },
  {
    ignores: ["dist-cli/**", "node_modules/**", ".cut/**", "out/**"]
  }
];
