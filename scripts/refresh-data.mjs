import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadLocalEnvironment() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

// Usage: pnpm refresh [--force] [--providers=coingecko,defillama]
const args = process.argv.slice(2);
const force = args.includes("--force");
const providersArg = args.find((arg) => arg.startsWith("--providers="));
const only = providersArg ? providersArg.slice("--providers=".length).split(",").map((value) => value.trim()).filter(Boolean) : undefined;

loadLocalEnvironment();

try {
  const { PROVIDER_STEPS } = await import("../src/lib/refresh/config.ts");
  const invalid = only?.filter((value) => !PROVIDER_STEPS.includes(value));
  if (invalid?.length) throw new Error(`Unknown provider(s): ${invalid.join(", ")}. Use ${PROVIDER_STEPS.join(", ")}.`);

  const { createSupabaseAdminClient } = await import("../src/lib/supabase/admin.ts");
  const { runDataRefresh } = await import("../src/lib/refresh/orchestrator.ts");
  const { SupabaseRefreshStore } = await import("../src/lib/refresh/store.ts");
  const client = createSupabaseAdminClient();
  const result = await runDataRefresh(client, new SupabaseRefreshStore(client), { trigger: "manual", force, only });

  if (result.status === "busy") {
    console.log("Another refresh run is in progress; nothing was started.");
  } else {
    console.log(`Refresh run ${result.runId}: ${result.status}.`);
    console.log(result.due.length ? `Due providers: ${result.due.join(", ")}.` : "No provider was due. Use --force to collect anyway.");
    for (const step of result.steps) {
      const detail = Object.entries(step.detail).map(([key, value]) => `${key}=${value}`).join(", ");
      console.log(`- ${step.step}: ${step.status}${detail ? ` (${detail})` : ""}${step.error ? ` — ${step.error}` : ""}`);
    }
  }
  if (result.status === "failed") process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown refresh error.";
  console.error(`Refresh did not complete: ${message}`);
  process.exitCode = 1;
}
