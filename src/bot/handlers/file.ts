import type { Context } from 'grammy';
import { writeFile } from 'fs/promises';
import path from 'path';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import type { Db } from '../../db/client.js';
import { getPendingTasks } from '../../db/queries/taskQueue.js';
import { config } from '../../config.js';
import { resolveAgentPrompt } from './agentIntent.js';

interface FileInfo {
  fileId: string;
  fileName: string;
  mimeType?: string;
}

function extractFileInfo(ctx: Context): FileInfo | null {
  const msg = ctx.message;
  if (!msg) return null;

  if (msg.document) {
    // SECURITY: use basename to strip any directory components from the Telegram-supplied name
    const rawName = msg.document.file_name ?? `file_${Date.now()}`;
    return {
      fileId: msg.document.file_id,
      fileName: path.basename(rawName) || `file_${Date.now()}`,
      mimeType: msg.document.mime_type,
    };
  }

  if (msg.photo && msg.photo.length > 0) {
    // Pick the highest resolution
    const largest = msg.photo[msg.photo.length - 1];
    return {
      fileId: largest.file_id,
      fileName: `photo_${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
    };
  }

  return null;
}

async function downloadFile(fileId: string): Promise<Buffer> {
  const infoRes = await fetch(
    `https://api.telegram.org/bot${config.BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const infoData = await infoRes.json() as { ok: boolean; result: { file_path: string } };
  if (!infoData.ok) throw new Error('Could not retrieve file info from Telegram');

  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${infoData.result.file_path}`
  );
  if (!fileRes.ok) throw new Error(`Failed to download file: ${fileRes.status}`);

  return Buffer.from(await fileRes.arrayBuffer());
}

export async function handleFileInProjectTopic(
  ctx: Context,
  projectManager: ProjectManager,
  db: Db,
): Promise<void> {
  const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
  if (!project) return;

  const fileInfo = extractFileInfo(ctx);
  if (!fileInfo) return;

  const caption = ctx.message?.caption?.trim() ?? '';

  let fileBuffer: Buffer;
  try {
    fileBuffer = await downloadFile(fileInfo.fileId);
  } catch (err) {
    console.error('[File] Download error:', err);
    await ctx.reply('❌ Could not download the file.');
    return;
  }

  const destPath = path.join(project.localPath, fileInfo.fileName);
  // SECURITY: verify the resolved path stays inside the project directory
  const resolvedBase = path.resolve(project.localPath);
  const resolvedDest = path.resolve(destPath);
  if (!resolvedDest.startsWith(resolvedBase + path.sep) && resolvedDest !== resolvedBase) {
    console.error(`[File] Path traversal attempt blocked: ${resolvedDest}`);
    await ctx.reply('❌ Invalid file name.');
    return;
  }

  // Relative display path: <projectName>/<fileName>
  const displayPath = `${project.name}/${fileInfo.fileName}`;

  try {
    await writeFile(destPath, fileBuffer);
  } catch (err) {
    console.error('[File] Write error:', err);
    await ctx.reply('❌ Could not save the file to the project directory.');
    return;
  }

  console.log(`[File] Saved ${fileInfo.fileName} to ${destPath}`);

  if (!caption) {
    await ctx.reply(
      `📎 File saved: \`${displayPath}\`\n\nSend a follow-up message to instruct the agent what to do with it.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Caption provided — queue it as a task referencing the file
  const session = projectManager.getSession(project.id);
  if (!session) {
    await ctx.reply(
      `📎 File saved: \`${displayPath}\`\n\n⚠️ Project session not found — could not queue task.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const prompt = resolveAgentPrompt(
    `The user has shared a file: \`${fileInfo.fileName}\` (saved at \`${destPath}\`).\n\n${caption}`
  );
  await session.queueTask(prompt);

  const pending = getPendingTasks(db, project.id);
  const queueMsg = pending.length > 1
    ? ` Task queued (position ${pending.length}).`
    : ' Task started.';

  await ctx.reply(
    `📎 File saved: \`${displayPath}\`\n✅${queueMsg}`,
    { parse_mode: 'Markdown' }
  );
}

export function setupFileHandler(bot: any, projectManager: ProjectManager, db: Db): void {
  bot.on('message:document', async (ctx: Context) => {
    await handleFileInProjectTopic(ctx, projectManager, db);
  });

  bot.on('message:photo', async (ctx: Context) => {
    await handleFileInProjectTopic(ctx, projectManager, db);
  });

  console.log('[File] File message handler enabled.');
}
