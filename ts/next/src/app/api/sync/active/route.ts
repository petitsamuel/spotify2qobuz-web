/**
 * Get active sync task API route.
 */

import { ensureDbInitialized, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
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
  } catch (error) {
    logger.error(`Failed to fetch active task: ${error}`);
    return jsonError('Failed to fetch active task', 500);
  }
}
