import { Router } from "express";
import { runRetentionCleanup } from "../services/retention-service.ts";

export const maintenanceRouter = Router();

// Internal-only: not part of the public integration contract (see
// docs/integration-contract.md). The server only ever binds to
// 127.0.0.1 (index.ts) so this is unreachable from outside localhost;
// this loopback-address check is a second, explicit layer on top of that
// rather than relying on the bind alone — there is no auth/customer
// concept yet to gate this behind (see docs/integration-contract.md
// "No auth yet").
function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

maintenanceRouter.post("/maintenance/cleanup", async (req, res) => {
  if (!isLoopback(req.socket.remoteAddress)) {
    res.status(403).json({ error: "FORBIDDEN", message: "internal endpoint" });
    return;
  }
  const summary = await runRetentionCleanup();
  res.json({ summary });
});
