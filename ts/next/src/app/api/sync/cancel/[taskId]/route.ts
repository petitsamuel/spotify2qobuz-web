/**
 * Cancel sync API route.
 */

import { NextRequest } from 'next/server';
import { ensureDbInitialized, jsonError } from '@/lib/api-helpers';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;
  const storage = await ensureDbInitialized();

  const task = await storage.getActiveTask(taskId);
  if (!task) {
    return jsonError('Task not found', 404);
  }

  await storage.updateActiveTask(taskId, 'cancelled');
  await storage.updateTask(taskId, 'cancelled');

  return Response.json({ status: 'cancelled' });
}
