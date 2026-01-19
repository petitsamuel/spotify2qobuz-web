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

      // Get cumulative stats from migration record
      let progress = activeTask.progress;
      let report = activeTask.report;
      if (activeTask.migration_id) {
        const migration = await storage.getMigration(activeTask.migration_id);
        if (migration) {
          // Merge cumulative stats from migration with chunk progress
          progress = {
            ...progress,
            tracks_matched: migration.tracks_matched || 0,
            tracks_not_matched: migration.tracks_not_matched || 0,
            isrc_matches: migration.isrc_matches || 0,
            fuzzy_matches: migration.fuzzy_matches || 0,
          };
          // Also merge cumulative stats into report for final display
          if (report) {
            report = {
              ...report,
              tracks_matched: migration.tracks_matched || 0,
              tracks_not_matched: migration.tracks_not_matched || 0,
              albums_matched: migration.tracks_matched || 0,
              albums_not_matched: migration.tracks_not_matched || 0,
              isrc_matches: migration.isrc_matches || 0,
              upc_matches: migration.isrc_matches || 0,
              fuzzy_matches: migration.fuzzy_matches || 0,
            };
          }
        }
      }

      const response: Record<string, unknown> = {
        task_id: taskId,
        status: activeTask.status,
        progress,
        report,
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
