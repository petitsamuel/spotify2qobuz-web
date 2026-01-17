/**
 * Get sync status API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, getCurrentUserId, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return jsonError('Not authenticated', 401);
  }

  const { taskId } = await params;

  try {
    const storage = await ensureDbInitialized();

    // First check active tasks
    const activeTask = await storage.getActiveTask(taskId);
    if (activeTask) {
      // Verify task belongs to current user
      if (activeTask.user_id !== userId) {
        return jsonError('Task not found', 404);
      }

      const response: Record<string, unknown> = {
        task_id: taskId,
        status: activeTask.status,
        progress: activeTask.progress,
        report: activeTask.report,
        error: activeTask.error,
      };

      // Include chunk state for chunk_complete status
      if (activeTask.status === 'chunk_complete' && activeTask.chunkState) {
        response.chunk_state = activeTask.chunkState;
      }

      return Response.json(response);
    }

    // Fall back to database task with user ownership check
    const dbTask = await storage.getTask(taskId);
    if (dbTask) {
      // Verify task belongs to current user
      if (dbTask.user_id !== userId) {
        return jsonError('Task not found', 404);
      }

      return Response.json({
        task_id: taskId,
        status: dbTask.status,
        progress: dbTask.progress,
      });
    }

    return jsonError('Task not found', 404);
  } catch (error) {
    logger.error(`Failed to fetch task status for ${taskId}: ${error}`);
    return jsonError('Failed to fetch task status', 500);
  }
}
