/**
 * Continue sync API route.
 * Continues a chunked sync from where it left off.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, getBothClients, getCurrentUserId, jsonError } from '@/lib/api-helpers';
import { runSyncChunk } from '@/lib/services/chunk-sync';
import { logger } from '@/lib/logger';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return jsonError('Not authenticated', 401);
  }

  const { taskId } = await params;

  const storage = await ensureDbInitialized();

  // Get the existing task
  const task = await storage.getActiveTask(taskId);
  if (!task) {
    return jsonError('Task not found', 404);
  }

  // Verify task belongs to current user
  if (task.user_id !== userId) {
    return jsonError('Task not found', 404);
  }

  // Only allow continuing chunk_complete tasks
  if (task.status !== 'chunk_complete') {
    return jsonError(`Cannot continue task with status: ${task.status}`, 400);
  }

  if (!task.chunkState) {
    return jsonError('Task has no chunk state to continue from', 400);
  }

  // Get clients
  const clients = await getBothClients(storage, userId);
  if (!clients) {
    return jsonError('Not authenticated', 401);
  }

  // Update task status to running
  await storage.updateActiveTask(taskId, 'running');
  await storage.updateTask(taskId, 'running');

  // Run the next chunk in background (fire and forget, but handle errors)
  runSyncChunk(
    userId,
    taskId,
    task.sync_type,
    task.dry_run,
    task.chunkState.offset, // Continue from where we left off
    storage,
    clients.spotify,
    clients.qobuz,
    task.migration_id
  ).catch(async (err) => {
    logger.error(`Unexpected chunk error for task ${taskId}: ${err}`);
    try {
      await storage.updateActiveTask(taskId, 'failed', undefined, String(err));
    } catch (updateErr) {
      logger.error(`Failed to update task status after error: ${updateErr}`);
    }
  });

  logger.info(`Continuing ${task.sync_type} sync chunk (task=${taskId}, offset=${task.chunkState.offset})`);
  return Response.json({ task_id: taskId, status: 'running' });
}
