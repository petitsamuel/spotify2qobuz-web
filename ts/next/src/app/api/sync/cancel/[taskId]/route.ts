/**
 * Cancel sync API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, jsonError } from '@/lib/api-helpers';
import { logger } from '@/lib/logger';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;

  try {
    const storage = await ensureDbInitialized();

    const task = await storage.getActiveTask(taskId);
    if (!task) {
      return jsonError('Task not found', 404);
    }

    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      return jsonError(`Task already ${task.status}`, 400);
    }

    // Update both tables - if either fails, we want to know
    await storage.updateActiveTask(taskId, 'cancelled');
    await storage.updateTask(taskId, 'cancelled');

    logger.info(`Task ${taskId} cancelled`);
    return Response.json({ status: 'cancelled' });
  } catch (error) {
    logger.error(`Failed to cancel task ${taskId}: ${error}`);
    return jsonError('Failed to cancel task', 500);
  }
}
