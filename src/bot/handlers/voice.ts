import type { Context } from 'grammy';
import type { ProjectManager } from '../../projects/ProjectManager.js';
import type { Db } from '../../db/client.js';
import { getPendingTasks } from '../../db/queries/taskQueue.js';
import { config } from '../../config.js';
import { resolveAgentPrompt } from './agentIntent.js';

export const DEFAULT_WAKE_WORD = 'agente';

/**
 * Strips the wake word from the start of the transcription.
 * Returns null if the wake word is not present.
 */
export function extractTask(transcription: string, wakeWord: string = DEFAULT_WAKE_WORD): string | null {
  const lower = transcription.toLowerCase().trim();
  if (!lower.startsWith(wakeWord.toLowerCase())) return null;
  return transcription.slice(wakeWord.length).replace(/^[\s,.:;]+/, '').trim() || null;
}

async function transcribeVoice(fileId: string): Promise<string> {
  const file = await fetch(
    `https://api.telegram.org/bot${config.BOT_TOKEN}/getFile?file_id=${fileId}`,
  );
  const fileData = await file.json() as { ok: boolean; result: { file_path: string } };
  if (!fileData.ok) throw new Error('Could not retrieve voice file info from Telegram');

  const audioResponse = await fetch(
    `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${fileData.result.file_path}`,
  );
  const audioBuffer = await audioResponse.arrayBuffer();

  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
  formData.append('model', 'whisper-1');

  const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` },
    body: formData,
  });

  if (!whisperResponse.ok) {
    throw new Error(`Whisper API error: ${whisperResponse.status} ${whisperResponse.statusText}`);
  }

  const { text } = await whisperResponse.json() as { text: string };
  return text;
}

export async function handleVoiceInProjectTopic(
  ctx: Context,
  projectManager: ProjectManager,
  db: Db,
): Promise<void> {
  if (!config.OPENAI_API_KEY) return;

  const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
  if (!project) return;

  const voice = ctx.message?.voice;
  if (!voice) return;

  let transcription: string;
  try {
    transcription = await transcribeVoice(voice.file_id);
  } catch (err) {
    console.error('[Voice] Transcription error:', err);
    await ctx.reply('❌ Could not transcribe voice message.');
    return;
  }

  const wakeWord = project.wakeWord ?? DEFAULT_WAKE_WORD;
  const task = extractTask(transcription, wakeWord);
  if (!task) return; // No wake word — ignore silently, it's just a conversation

  const session = projectManager.getSession(project.id);
  if (!session) {
    await ctx.reply('Project session not found. Project may be paused or archived.');
    return;
  }

  // Echo transcription so the team can see what was sent to the agent
  await ctx.reply(`🎙 *${transcription}*`, { parse_mode: 'Markdown' });
  await session.queueTask(resolveAgentPrompt(task));

  const pending = getPendingTasks(db, project.id);
  if (pending.length > 1) {
    await ctx.reply(`✅ Task queued (position ${pending.length}). Current task will finish first.`);
  }
}

export function setupVoiceHandler(bot: any, projectManager: ProjectManager, db: Db): void {
  if (!config.OPENAI_API_KEY) {
    console.log('[Voice] OPENAI_API_KEY not set — voice messages disabled.');
    return;
  }

  bot.on('message:voice', async (ctx: Context) => {
    await handleVoiceInProjectTopic(ctx, projectManager, db);
  });

  console.log('[Voice] Voice message handler enabled.');
}
