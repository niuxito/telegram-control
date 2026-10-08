import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { ProjectManager } from '../../../projects/ProjectManager.js';
import { getPendingTasks } from '../../../db/queries/taskQueue.js';
import { insertLocalIssue, listLocalIssues, closeLocalIssue } from '../../../db/queries/localIssues.js';
import { buildPlanningIssuePrompt } from '../agentIntent.js';
import type { Db } from '../../../db/client.js';
import { simpleGit } from 'simple-git';

const pendingIssueRequest = new Map<number, { projectId: number; description: string }>();

export function getPendingIssueRequest(userId: number) {
  return pendingIssueRequest.get(userId);
}
export function clearPendingIssueRequest(userId: number) {
  pendingIssueRequest.delete(userId);
}

async function getGithubRemote(projectPath: string): Promise<string | null> {
  try {
    const git = simpleGit(projectPath);
    const remotes = await git.getRemotes(true);
    const gh = remotes.find(r =>
      r.refs.fetch?.includes('github.com') || r.refs.push?.includes('github.com')
    );
    return gh?.refs.fetch ?? null;
  } catch {
    return null;
  }
}

export function setupIssueHandlers(bot: any, projectManager: ProjectManager, db: Db): void {

  bot.command('issue', async (ctx: Context) => {
    const project = projectManager.getByTopicId(ctx.message?.message_thread_id ?? -1);
    if (!project) {
      await ctx.reply('This command must be used in a project topic.');
      return;
    }

    const raw = (ctx.match as string).trim();
    const args = raw.split(/\s+/);
    const sub = args[0]?.toLowerCase();

    if (sub === 'list') {
      const filter = (args[1] === 'closed' ? 'closed' : 'open') as 'open' | 'closed';
      const githubRemote = await getGithubRemote(project.localPath);
      const session = projectManager.getSession(project.id);
      if (githubRemote && session) {
        await session.queueTask(
          `List the ${filter} GitHub issues for this project.\n` +
          `Run: gh issue list --state ${filter} --limit 20\n` +
          `Format the output as a numbered list with title and issue number.`
        );
      } else {
        const issues = listLocalIssues(db, project.id, filter);
        if (issues.length === 0) {
          await ctx.reply(`No ${filter} issues found.`);
          return;
        }
        const lines = issues.map(i =>
          `#${i.id} ${i.title}\n   ${i.body.slice(0, 80)}${i.body.length > 80 ? '…' : ''}`
        ).join('\n\n');
        await ctx.reply(`Local issues (${filter}):\n\n${lines}`);
      }
      return;
    }

    if (sub === 'close') {
      const id = parseInt(args[1]);
      if (isNaN(id)) {
        await ctx.reply('Usage: /issue close <id>');
        return;
      }
      const githubRemote = await getGithubRemote(project.localPath);
      const session = projectManager.getSession(project.id);
      if (githubRemote && session) {
        await session.queueTask(`Close GitHub issue #${id}: run gh issue close ${id} and confirm.`);
      } else {
        closeLocalIssue(db, id, project.id);
        await ctx.reply(`✅ Issue #${id} closed.`);
      }
      return;
    }

    const description = sub === 'create' ? args.slice(1).join(' ').trim() : raw;
    if (!description) {
      await ctx.reply(
        'Usage:\n' +
        '/issue <description> — create issue\n' +
        '/issue list [open|closed] — list issues\n' +
        '/issue close <id> — close an issue'
      );
      return;
    }

    const session = projectManager.getSession(project.id);
    if (!session) {
      await ctx.reply('Project session not found. Project may be paused or archived.');
      return;
    }

    const githubRemote = await getGithubRemote(project.localPath);

    if (githubRemote) {
      await session.queueTask(buildPlanningIssuePrompt(description, true));
      const pending = getPendingTasks(db, project.id);
      if (pending.length > 1) {
        await ctx.reply(`✅ Issue task queued (position ${pending.length}).`);
      } else {
        await ctx.reply('✅ Planning agent started — analysing codebase and creating issue...');
      }
    } else {
      const userId = ctx.from?.id;
      if (!userId) return;
      pendingIssueRequest.set(userId, { projectId: project.id, description });
      const keyboard = new InlineKeyboard()
        .text('Create GitHub repo first', `setup_github_for_issue:${userId}`)
        .row()
        .text('Store locally', `local_issue:${userId}`);
      await ctx.reply(
        'No GitHub remote found for this project. What would you like to do?',
        { reply_markup: keyboard }
      );
    }
  });
}
