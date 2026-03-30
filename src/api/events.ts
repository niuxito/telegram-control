import { EventEmitter } from 'events';

export type AgentEvent =
  | { type: 'task:started';   agentId: number; agentName: string; taskId: number; prompt: string }
  | { type: 'task:output';    agentId: number; agentName: string; text: string }
  | { type: 'task:completed'; agentId: number; agentName: string; taskId: number; costUsd: number }
  | { type: 'task:failed';    agentId: number; agentName: string; taskId: number }
  | { type: 'heartbeat' };

class AgentEventBus extends EventEmitter {
  emit(event: 'agent', data: AgentEvent): boolean {
    return super.emit('agent', data);
  }
  on(event: 'agent', listener: (data: AgentEvent) => void): this {
    return super.on('agent', listener);
  }
  off(event: 'agent', listener: (data: AgentEvent) => void): this {
    return super.off('agent', listener);
  }
}

export const agentEvents = new AgentEventBus();
