import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error"
    }
  },
  {
    // Not repo source: generated build output (the tsc dist tree and the esbuild
    // skill bundle, now at the unit's Base/scripts/), and installed coding-tool
    // configs — installed skill bundles carry their own runtime globals.
    ignores: [
      "dist/**",
      "node_modules/**",
      "skills/**/Base/scripts/**",
      ".claude/**",
      ".agents/**",
      ".opencode/**"
    ]
  }
);
