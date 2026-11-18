-- DM logs are always read newest first (dashboard, DM logs page, hourly cap,
-- comment sweep). Without these, every read sorts the whole table.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DmLog_workspaceId_createdAt_idx" ON "DmLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DmLog_automationId_createdAt_idx" ON "DmLog"("automationId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DmLog_instagramAccountId_createdAt_idx" ON "DmLog"("instagramAccountId", "createdAt");
