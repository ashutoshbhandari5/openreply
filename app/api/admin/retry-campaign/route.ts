import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";

export const runtime = "nodejs";

// Re-sends a campaign's comment DMs that never went out because Instagram had
// the account's messaging switched off ("Service temporarily unavailable",
// code 2). Those sends are marked unconfirmed, so nothing retries them on its
// own.
//
// It trickles them out instead of sending in bulk: one job every
// RETRY_SPACING_MS (20 an hour), which leaves room under the worker's hourly
// cap for new comments. A burst is what gets messaging disabled in the first
// place. The rows stay marked unconfirmed until their job runs, so the
// comment sweep doesn't pick them all up at once.
// Instagram allows one private reply per comment, so a comment that did get
// its DM after all is simply refused, never sent twice.
const RETRY_SPACING_MS = 180_000;
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const automationId = request.nextUrl.searchParams.get("automationId");
  if (!automationId) {
    return NextResponse.json({ success: false, error: "automationId is required" }, { status: 400 });
  }

  const automation = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId, isActive: true },
    select: {
      id: true,
      postId: true,
      instagramAccountId: true,
      instagramAccount: { select: { instagramId: true } },
    },
  });
  if (!automation?.postId) {
    return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
  }

  const logs = await prisma.dmLog.findMany({
    where: {
      automationId: automation.id,
      createdAt: { gte: new Date(Date.now() - PRIVATE_REPLY_WINDOW_MS) },
      NOT: [
        { commentId: { startsWith: "reveal:" } },
        // Instagram refuses DMs to these accounts outright; retrying won't help.
        { errorMessage: { contains: "code=100" } },
      ],
      OR: [
        { status: "FAILED", errorMessage: { contains: "code=2]" } },
        { status: "FAILED", errorMessage: { contains: "code=2 " } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, commentId: true, commentText: true, commenterId: true, commenterName: true },
  });

  const queue = getDMQueue();
  const stamp = Date.now().toString(36);
  let queued = 0;
  for (const log of logs) {
    await queue.add(
      "process-comment",
      {
        instagramAccountId: automation.instagramAccount.instagramId,
        accountConnectionId: automation.instagramAccountId,
        commentId: log.commentId,
        commentText: log.commentText ?? "",
        commenterId: log.commenterId,
        commenterName: log.commenterName ?? undefined,
        mediaId: automation.postId,
        source: "POLLING",
        retryUnconfirmed: true,
      },
      { delay: queued * RETRY_SPACING_MS, jobId: `retry_${log.id}_${stamp}` },
    );
    queued += 1;
  }

  return NextResponse.json({
    success: true,
    data: { queued, spacingSeconds: RETRY_SPACING_MS / 1000, finishesInMinutes: Math.ceil((queued * RETRY_SPACING_MS) / 60_000) },
  });
}
