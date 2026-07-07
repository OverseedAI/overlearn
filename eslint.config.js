import eslint from "@eslint/js";
import typescriptEslint from "typescript-eslint";

export default typescriptEslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      ".bun-cache/**",
      ".tmp/**",
      "src-tauri/target/**",
      // The SPA package lints/typechecks with its own toolchain (ui/tsconfig.json).
      "ui/**",
      "src/daemon/spa-assets.gen.ts",
    ],
  },
  eslint.configs.recommended,
  ...typescriptEslint.configs.recommended,
);
