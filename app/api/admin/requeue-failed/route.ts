import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { requeueAuthFailures } from "@/lib/queue/recover-auth-failures";

export const runtime = "nodejs";

// Re-sends DMs and button taps that failed because an account's session was
// invalidated. Runs automatically on reconnect; this is the manual trigger.
export async function POST() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const result = await requeueAuthFailures({ workspaceId });
  return NextResponse.json({ success: true, data: result });
}
