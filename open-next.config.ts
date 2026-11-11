import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every page is force-dynamic and reads live data, so no incremental cache is configured: the
// default (dummy) cache is enough, and nothing needs R2, KV or D1.
export default defineCloudflareConfig();
