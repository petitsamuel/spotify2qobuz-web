/**
 * Get active sync task API route.
 */

import { ensureDbInitialized, getCurrentUserId, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      return jsonError('Not authenticated', 401);
    }

    const storage = await ensureDbInitialized();

    // Clean up any stale tasks before checking for running ones
    const cleanedUp = await storage.cleanupStaleActiveTasks();
    if (cleanedUp > 0) {
      logger.info(`Cleaned up ${cleanedUp} stale task(s)`);
    }

    const task = await storage.getRunningTask(userId);
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
