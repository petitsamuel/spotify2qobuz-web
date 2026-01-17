/**
 * Get active sync task API route.
 */

import { ensureDbInitialized } from '@/lib/api-helpers';

export async function GET() {
  const storage = await ensureDbInitialized();

  const task = await storage.getRunningTask();
  if (!task) {
    return Response.json({});
  }

  return Response.json({
    task_id: task.id,
    sync_type: task.sync_type,
    progress: task.progress,
    dry_run: task.dry_run,
  });
}
