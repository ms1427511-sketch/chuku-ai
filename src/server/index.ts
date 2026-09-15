import { app } from "./app.ts";
import { config } from "./config/env.ts";
import { reconcileAllProcessingOnStartup } from "./services/product-generation-service.ts";

// Host is configurable via CHUKU_HOST but the safe default is always
// 127.0.0.1 — this module never defaults to 0.0.0.0 itself (config/env.ts).
// This server proxies a provider secret and must never be reachable from
// outside localhost unless an operator explicitly opts in.
app.listen(config.port, config.host, () => {
  console.log(`Chuku AI Lab server listening on http://${config.host}:${config.port} (deployment mode: ${config.deploymentMode})`);
  // Restart recovery: reconcile any generation left "processing" by a
  // prior process — at most one free status check per record, never a
  // new paid provider call. See product-generation-service.ts.
  reconcileAllProcessingOnStartup()
    .then((count) => {
      if (count > 0) console.log(`Reconciled ${count} generation(s) left "processing" from a prior run.`);
    })
    .catch((error: unknown) => {
      console.error("Startup reconciliation failed:", error instanceof Error ? error.message : error);
    });
});
