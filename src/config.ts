// Server settings, read once from the environment, and helpers for the bundled data files.
// HTTP-client settings (URL, credentials, TLS, paths for files) live in client.ts's loadConfig.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Path of a file bundled with the server (spec/, package.json). */
export const bundled = (...parts: string[]) => join(root, ...parts);

/** Reads a JSON file, naming the file in the error if it cannot be parsed. */
export function loadJson<T>(path: string, what: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`[vsp360-mcp] cannot read ${what} at ${path}: ${(e as Error).message}`);
  }
}

/** Like loadJson, but returns `fallback` when the path is empty or the file does not exist. */
export function loadOptionalJson<T>(path: string | undefined, what: string, fallback: T): T {
  return path && existsSync(path) ? loadJson<T>(path, what) : fallback;
}

export const VERSION: string = loadJson<{ version: string }>(bundled("package.json"), "package.json").version;

export interface ServerConfig {
  specPath: string;
  allowWrites: boolean;
  allowSecretReads: boolean;
  toolsets: string[];
  examplesPath: string;
  analyticsFieldsPath: string;
  decision: {
    logPath?: string;
    linkSeconds: number;
    collect: boolean;
    collectSeconds: number;
    hintMode: string;
    modelPath: string;
  };
}

export function loadServerConfig(env = process.env): ServerConfig {
  return {
    specPath: env.VSP360_SPEC || bundled("spec", "Platform-vsp360-openapi.yaml"),
    allowWrites: env.VSP360_ALLOW_WRITES === "true",
    allowSecretReads: env.VSP360_ALLOW_SECRET_READS === "true",
    toolsets: (env.VSP360_TOOLSETS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // An empty VSP360_EXAMPLES turns the example questions off.
    examplesPath: env.VSP360_EXAMPLES ?? bundled("spec", "examples.json"),
    analyticsFieldsPath: env.VSP360_ANALYTICS_FIELDS ?? bundled("spec", "analytics-fields.json"),
    decision: {
      logPath: env.VSP360_DECISION_LOG || undefined,
      linkSeconds: Number(env.VSP360_DECISION_LINK_SECONDS) || 120,
      collect: env.VSP360_DECISION_COLLECT === "true",
      collectSeconds: Number(env.VSP360_DECISION_COLLECT_SECONDS) || 600,
      hintMode: env.VSP360_DECISION_HINT ?? "false",
      modelPath: env.VSP360_DECISION_MODEL ?? bundled("spec", "decision-model.json"),
    },
  };
}
