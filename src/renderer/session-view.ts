import type { AppState, Project, Session } from './bridge';

// Sessions are appended to the history. A retry must replace its older attempt
// in the working view without discarding that history.
export function projectSession(state: AppState, project: Pick<Project, 'id' | 'studio'>): Session | undefined {
  const entry = state.batch?.entries.find(e => e.project.id === project.id && e.project.studio === project.studio);
  if (entry?.status === 'pending' && !entry.sessionId) return undefined;
  if (entry?.status === 'running' && !entry.sessionId) return {
    id: `discovering:${project.studio}:${project.id}`, projectId: project.id, studio: project.studio,
    status: 'discovering', message: 'Searching the configured sources for delivery videos.',
  };
  const sessions = state.sessions ?? [];
  if (entry?.sessionId) {
    const active = sessions.find(s => s.id === entry.sessionId);
    if (active) return active;
  }
  return [...sessions].reverse().find(s => s.projectId === project.id && s.studio === project.studio);
}

export function queueProjects(state: AppState): Project[] {
  return (state.projects ?? []).map(project => {
    const entry = state.batch?.entries.find(e => e.project.id === project.id && e.project.studio === project.studio);
    if (!entry || project.status === 'Reviewed' || (entry.status === 'skipped' && project.status !== 'Skip')) return project;
    const status = { pending: 'To Do', running: 'In Process', done: 'Done', skipped: 'Skip', failed: 'In Process' }[entry.status];
    return { ...project, status };
  });
}
