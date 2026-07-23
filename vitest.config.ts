import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: { branches: 80, functions: 80, lines: 80, statements: 80 },
      include: [
        "src/{state,model,managed-config,response}.ts",
        "src/domain/{job,task,repository-path}.ts",
        "src/adapters/sqlite-*.ts",
      ],
    },
  },
});
