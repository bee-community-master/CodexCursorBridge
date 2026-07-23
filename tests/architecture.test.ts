import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isConstructorDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isSetAccessorDeclaration,
  preProcessFile,
  ScriptTarget,
  type Node,
} from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve("src");
const testRoot = path.resolve("tests");
const maximumImplementationLines = 700;
const maximumFunctionLines = 180;
const maximumTestLines = 900;

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  }));
  return nested.flat().sort();
}

function sourceFiles(): Promise<string[]> {
  return typescriptFiles(sourceRoot);
}

function displayPath(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

function importedModules(source: string): string[] {
  return preProcessFile(source, true, true).importedFiles
    .map((imported) => imported.fileName);
}

function resolveSourceImport(file: string, imported: string): string | undefined {
  if (!imported.startsWith(".")) return undefined;
  const candidate = path.resolve(path.dirname(file), imported.replace(/\.js$/, ".ts"));
  return candidate.startsWith(`${sourceRoot}${path.sep}`) ? candidate : undefined;
}

describe("architecture boundaries", () => {
  it("keeps implementation files below the agreed maintainability ceiling", async () => {
    const oversized: string[] = [];
    for (const file of await sourceFiles()) {
      const lines = (await readFile(file, "utf8")).split("\n").length;
      if (lines > maximumImplementationLines) {
        oversized.push(`${displayPath(file)} (${lines})`);
      }
    }

    expect(oversized, "split files by responsibility instead of growing God modules")
      .toEqual([]);
  });

  it("keeps individual functions small enough to review as one unit", async () => {
    const oversized: string[] = [];
    for (const file of await sourceFiles()) {
      const source = await readFile(file, "utf8");
      const syntax = createSourceFile(file, source, ScriptTarget.Latest, true);
      const visit = (node: Node): void => {
        const functionLike = isFunctionDeclaration(node)
          || isMethodDeclaration(node)
          || isArrowFunction(node)
          || isFunctionExpression(node)
          || isConstructorDeclaration(node)
          || isGetAccessorDeclaration(node)
          || isSetAccessorDeclaration(node);
        if (functionLike && node.body) {
          const start = syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1;
          const end = syntax.getLineAndCharacterOfPosition(node.end).line + 1;
          const lines = end - start + 1;
          if (lines > maximumFunctionLines) {
            oversized.push(`${displayPath(file)}:${start} (${lines})`);
          }
        }
        forEachChild(node, visit);
      };
      visit(syntax);
    }

    expect(oversized, "extract named phases instead of growing orchestration functions")
      .toEqual([]);
  });

  it("keeps test suites small enough to retain one reviewable concern", async () => {
    const oversized: string[] = [];
    for (const file of await typescriptFiles(testRoot)) {
      const lines = (await readFile(file, "utf8")).split("\n").length;
      if (lines > maximumTestLines) {
        oversized.push(`${displayPath(file)} (${lines})`);
      }
    }

    expect(oversized, "split test suites along production responsibility boundaries")
      .toEqual([]);
  });

  it("keeps domain and application code independent from outbound adapters", async () => {
    const innerFiles = (await sourceFiles()).filter((file) => {
      const relative = displayPath(file);
      return relative.startsWith("src/domain/")
        || relative.startsWith("src/application/");
    });
    expect(innerFiles.length).toBeGreaterThan(0);

    const forbiddenPackages = [
      "@cursor/sdk",
      "@modelcontextprotocol/sdk",
      "node:child_process",
      "node:fs",
      "node:sqlite",
    ];
    const forbiddenSourceModules = new Set([
      "bootstrap.ts",
      "config.ts",
      "dispatch.ts",
      "git.ts",
      "keychain.ts",
      "launchd.ts",
      "mcp.ts",
      "real-adapter.ts",
      "sandbox.ts",
      "state.ts",
      "supervisor.ts",
      "worker.ts",
    ]);
    const violations: string[] = [];

    for (const file of innerFiles) {
      const source = await readFile(file, "utf8");
      for (const imported of importedModules(source)) {
        if (forbiddenPackages.some((prefix) => imported.startsWith(prefix))) {
          violations.push(`${displayPath(file)} -> ${imported}`);
        }
        const resolved = resolveSourceImport(file, imported);
        if (resolved && forbiddenSourceModules.has(path.basename(resolved))) {
          violations.push(`${displayPath(file)} -> ${displayPath(resolved)}`);
        }
        if (resolved) {
          const sourcePath = displayPath(file);
          const targetPath = displayPath(resolved);
          const targetIsInner = targetPath.startsWith("src/domain/")
            || targetPath.startsWith("src/application/");
          const domainDependsOnApplication = sourcePath.startsWith("src/domain/")
            && targetPath.startsWith("src/application/");
          if (!targetIsInner || domainDependsOnApplication) {
            violations.push(`${sourcePath} -> ${targetPath}`);
          }
        }
      }
    }

    expect(violations, "inner layers must own ports instead of importing adapters")
      .toEqual([]);
  });

  it("has no relative source import cycles", async () => {
    const files = await sourceFiles();
    const known = new Set(files);
    const graph = new Map<string, string[]>();
    for (const file of files) {
      const imports = importedModules(await readFile(file, "utf8"))
        .map((imported) => resolveSourceImport(file, imported))
        .filter((resolved): resolved is string => resolved !== undefined && known.has(resolved));
      graph.set(file, imports);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycles: string[] = [];
    const walk = (file: string, trail: string[]): void => {
      if (visiting.has(file)) {
        const start = trail.indexOf(file);
        cycles.push([...trail.slice(start), file].map(displayPath).join(" -> "));
        return;
      }
      if (visited.has(file)) return;
      visiting.add(file);
      for (const dependency of graph.get(file) ?? []) walk(dependency, [...trail, file]);
      visiting.delete(file);
      visited.add(file);
    };
    for (const file of files) walk(file, []);

    expect([...new Set(cycles)]).toEqual([]);
  });
});
