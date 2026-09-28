import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export async function parseProjectName(userMessage: string): Promise<string | null> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 64,
    system: 'Extract only the project name (kebab-case, no spaces) from the user message. Respond with ONLY the name string (e.g. "price-tracker"). If you cannot extract a name, respond with null.',
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
  if (!text || text === 'null') return null;

  // Sanitize: keep only alphanumeric, hyphens, underscores
  const sanitized = text.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized || null;
}

export async function summarizeTaskResult(result: string): Promise<string> {
  if (result.length < 500) return result;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Summarize this task result in 2-3 sentences:\n\n${result.slice(0, 3000)}`,
    }],
  });

  return response.content[0].type === 'text' ? response.content[0].text : result.slice(0, 500);
}
