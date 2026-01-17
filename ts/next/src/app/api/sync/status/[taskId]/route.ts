/**
 * Get sync status API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, jsonError } from '@/lib/api-helpers';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;
  const storage = await ensureDbInitialized();

  // First check active tasks
  const activeTask = await storage.getActiveTask(taskId);
  if (activeTask) {
    return Response.json({
      task_id: taskId,
      status: activeTask.status,
      progress: activeTask.progress,
      report: activeTask.report,
      error: activeTask.error,
    });
  }

  // Fall back to database task
  const dbTask = await storage.getTask(taskId);
  if (dbTask) {
    return Response.json({
      task_id: taskId,
      status: dbTask.status,
      progress: dbTask.progress,
    });
  }

  return jsonError('Task not found', 404);
}
