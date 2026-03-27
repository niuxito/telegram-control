import { InlineKeyboard } from 'grammy';

export function confirmCancelKeyboard(confirmData: string, cancelData: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Confirm', confirmData)
    .text('❌ Cancel', cancelData);
}

export function projectActionsKeyboard(projectId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('📊 Status', `project:status:${projectId}`)
    .text('⏸ Pause', `project:pause:${projectId}`)
    .row()
    .text('🗄 Archive', `project:archive:${projectId}`)
    .text('🔄 New Session', `project:newsession:${projectId}`);
}
