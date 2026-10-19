import { prisma } from "@/lib/db/client";
import { getDMQueue, POSTBACK_JOB_NAME } from "@/lib/queue/client";

// Meta answers every call with code 190 once an account's session is
// invalidated (password change, security reset). Until the account is
// reconnected, every comment DM and every "I'm following" tap fails, and those
// people are left with a follow prompt that never pays off. Once a fresh token
// is saved, this puts their sends back on the queue:
//   - comment DMs get their attempt budget back and are re-enqueued;
//   - button taps are replayed as a follow-check, so they still get the link
//     only if they follow (or get the prompt again if they don't).
// Both paths stay idempotent: the worker's per-leg claims stop a double send.

const AUTH_FAILURE = "code=190";
// Instagram only allows a private reply within 7 days of the comment, and a
// reply to a button tap within 24 hours of it. Anything older can't be sent.
const COMMENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TAP_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function requeueAuthFailures({
  workspaceId,
  instagramAccountDbId,
}: {
  workspaceId: string;
  instagramAccountDbId?: string;
}): Promise<{ comments: number; taps: number }> {
  const now = Date.now();
  const failed = await prisma.dmLog.findMany({
    where: {
      workspaceId,
      ...(instagramAccountDbId ? { instagramAccountId: instagramAccountDbId } : {}),
      status: "FAILED",
      dmDeliveryUnconfirmed: false,
      errorMessage: { contains: AUTH_FAILURE },
      createdAt: { gte: new Date(now - COMMENT_WINDOW_MS) },
      automation: { isActive: true },
    },
    select: {
      id: true,
      commentId: true,
      commentText: true,
      commenterId: true,
      commenterName: true,
      createdAt: true,
      automationId: true,
      instagramAccountId: true,
      automation: { select: { postId: true } },
      instagramAccount: { select: { instagramId: true } },
    },
  });

  const queue = getDMQueue();
  const stamp = now.toString(36);
  let comments = 0;
  let taps = 0;

  for (const log of failed) {
    const isTap = log.commentId.startsWith("reveal:");

    if (isTap) {
      if (now - log.createdAt.getTime() > TAP_WINDOW_MS) continue;
      // Drop the auth marker so a second reconnect doesn't replay this tap.
      await prisma.dmLog.update({
        where: { id: log.id },
        data: { errorMessage: "Re-queued after the account was reconnected" },
      });
      await queue.add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: log.instagramAccount.instagramId,
          accountConnectionId: log.instagramAccountId,
          userId: log.commenterId,
          payload: `followcheck:${log.automationId}`,
        },
        { jobId: `recover_tap_${log.id}_${stamp}` },
      );
      taps += 1;
      continue;
    }

    if (!log.automation.postId) continue;
    await prisma.dmLog.update({
      where: { id: log.id },
      data: { attempts: 0, errorMessage: null },
    });
    await queue.add(
      "process-comment",
      {
        instagramAccountId: log.instagramAccount.instagramId,
        accountConnectionId: log.instagramAccountId,
        commentId: log.commentId,
        commentText: log.commentText ?? "",
        commenterId: log.commenterId,
        commenterName: log.commenterName ?? undefined,
        mediaId: log.automation.postId,
        source: "POLLING",
      },
      { jobId: `recover_comment_${log.id}_${stamp}` },
    );
    comments += 1;
  }

  return { comments, taps };
}
