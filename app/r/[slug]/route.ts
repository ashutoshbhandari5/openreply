import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import {
  getRequestIp,
  hashClickIp,
  hashRecipientId,
  parseRecipientToken,
} from "@/lib/tracking/server";

type RedirectRouteProps = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  const trackedLink = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      id: true,
      workspaceId: true,
      automationId: true,
      destinationUrl: true,
      automation: {
        select: {
          instagramAccountId: true,
        },
      },
    },
  });

  if (!trackedLink) {
    return handleMissingLink(request);
  }

  await prisma.linkClick.create({
    data: {
      workspaceId: trackedLink.workspaceId,
      automationId: trackedLink.automationId,
      instagramAccountId: trackedLink.automation.instagramAccountId,
      trackedLinkId: trackedLink.id,
      ipHash: hashClickIp(getRequestIp(request)),
      recipientHash: parseRecipientToken(
        new URL(request.url).searchParams.get("r")
      ),
      userAgent: request.headers.get("user-agent"),
      referrer: request.headers.get("referer"),
    },
  });

  return NextResponse.redirect(trackedLink.destinationUrl, { status: 302 });
}

// A link whose campaign was deleted (a disconnect wipes every campaign on the
// account) used to bounce people to the OpenReply homepage, which reads as a
// bait and switch. Instead: if the link carries the recipient token, find the
// live campaign that most recently dealt with that person and send them to its
// link. Otherwise show a short page listing the live links to pick from.
async function handleMissingLink(request: NextRequest) {
  const recipient = parseRecipientToken(
    new URL(request.url).searchParams.get("r")
  );

  if (recipient) {
    const logs = await prisma.dmLog.findMany({
      where: {
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        automation: { isActive: true },
      },
      select: { commenterId: true, automationId: true },
      orderBy: { createdAt: "desc" },
      take: 20000,
    });
    const hit = logs.find((log) => hashRecipientId(log.commenterId) === recipient);
    if (hit) {
      const link = await prisma.trackedLink.findFirst({
        where: { automationId: hit.automationId },
        orderBy: TRACKED_LINK_ORDER,
        select: { slug: true },
      });
      if (link) {
        const next = new URL(`/r/${link.slug}`, request.url);
        next.searchParams.set("r", recipient);
        return NextResponse.redirect(next, { status: 302 });
      }
    }
  }

  const automations = await prisma.automation.findMany({
    where: { isActive: true, trackedLinks: { some: {} } },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      name: true,
      trackedLinks: {
        orderBy: TRACKED_LINK_ORDER,
        take: 1,
        select: { slug: true },
      },
    },
  });

  const items = automations
    .filter((a) => a.trackedLinks[0])
    .map(
      (a) =>
        `<li><a href="/r/${encodeURIComponent(a.trackedLinks[0].slug)}">${escapeHtml(a.name)}<span aria-hidden="true">→</span></a></li>`
    )
    .join("");

  return new NextResponse(movedPage(items), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function movedPage(items: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>This link moved</title>
<style>
  :root { --bg: #f6f5f2; --card: #ffffff; --ink: #1b1a17; --muted: #6b675f; --line: #e3e0d9; --accent: #1b1a17; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121212; --card: #1c1c1c; --ink: #f1efea; --muted: #a29d94; --line: #2e2d2a; --accent: #f1efea; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 440px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 24px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.01em; }
  p { margin: 0 0 24px; color: var(--muted); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  a { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; color: var(--ink); text-decoration: none; font-weight: 600; }
  a:hover, a:focus-visible { border-color: var(--accent); outline: none; }
  a span { color: var(--muted); font-weight: 400; }
</style>
</head>
<body>
<main>
  <h1>This link moved</h1>
  <p>Sorry about that. Tap the one you came for and it opens right away.</p>
  <ul>${items}</ul>
</main>
</body>
</html>`;
}
