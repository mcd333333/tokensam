import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every page is force-dynamic with no ISR or revalidation, so no incremental cache is needed.
export default defineCloudflareConfig();
