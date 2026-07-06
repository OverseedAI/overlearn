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
    ],
  },
  eslint.configs.recommended,
  ...typescriptEslint.configs.recommended,
);
