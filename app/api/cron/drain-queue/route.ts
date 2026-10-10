import { NextRequest, NextResponse } from "next/server";
import os from "node:os";
import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { attachPendingNextReels } from "@/lib/automation/attach-next-reel";

// Serverless stand-in for `npm run worker`. A Vercel cron hits this every
// minute; each run consumes the BullMQ send queue for ~55s, then closes the
// worker cleanly so the next run picks up where it left off. BullMQ's Redis
// locks make overlapping runs safe.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const RUN_FOR_MS = Number(process.env.DRAIN_RUN_FOR_MS ?? 55_000);
const HEARTBEAT_INTERVAL_MS = 20_000;
const POLL_EVERY_MINUTES = Math.max(
  1,
  Math.round(Number(process.env.COMMENT_POLL_INTERVAL_MS ?? 300_000) / 60_000)
);

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();
  const beat = () =>
    recordWorkerHeartbeat({ pid: process.pid, hostname: os.hostname(), startedAt }).catch(
      (error) => console.error("[Drain] Heartbeat failed:", error instanceof Error ? error.message : error)
    );

  let completed = 0;
  let failed = 0;
  const worker = createDMWorker();
  worker.on("completed", () => completed++);
  worker.on("failed", () => failed++);

  await beat();
  const heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);

  let polled = false;
  try {
    // Same safety-net sweep the long-running worker does every few minutes.
    if (new Date().getUTCMinutes() % POLL_EVERY_MINUTES === 0) {
      polled = true;
      try {
        await attachPendingNextReels();
        await reconcileComments();
      } catch (error) {
        console.error("[Drain] Reconciliation failed:", error instanceof Error ? error.message : error);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, RUN_FOR_MS));
  } finally {
    clearInterval(heartbeatTimer);
    // Waits for in-flight jobs to finish before returning.
    await worker.close();
  }

  return NextResponse.json({ success: true, data: { completed, failed, polled } });
}
