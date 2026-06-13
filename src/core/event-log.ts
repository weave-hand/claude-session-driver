import type { WorkerEvent } from '../events.js';

export type WorkerStatus =
  | 'idle'
  | 'working'
  | 'terminated'
  | 'gone'
  | 'unknown';

export function classifyStatus(last: WorkerEvent): WorkerStatus {
  switch (last.event) {
    case 'session_end':
      return 'terminated';
    case 'user_prompt_submit':
    case 'pre_tool_use':
    case 'post_tool_use':
      return 'working';
    case 'stop':
    case 'session_start':
      return 'idle';
    default: {
      const _exhaustive: never = last;
      return _exhaustive;
    }
  }
}
