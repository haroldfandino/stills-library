import { describe, expect, it } from 'vitest';
import { projectSession, queueProjects } from './session-view';
import type { AppState, Project, Session } from './bridge';

const project: Project = { id: '1287', studio: 'filmkraft', name: 'Mustela', status: 'Skip' };
const old: Session = { id: 'old', projectId: project.id, studio: project.studio, status: 'skipped' };
const retry: Session = { ...old, id: 'retry', status: 'analyzing' };
function state(status: 'pending' | 'running', sessionId?: string): AppState {
  return { projects: [project], sessions: [old, retry], batch: {
    id: 'batch', status: 'running', entries: [{ project: { ...project, studio: 'filmkraft', row: 2 }, status, sessionId }],
    excluded: [], startedAt: '', updatedAt: '', reportPath: '',
  } };
}

describe('retry presentation', () => {
  it('shows the current sheet status after manually recovering an automatic missing-source skip', () => {
    const value = state('running', 'retry');
    value.batch!.entries[0].status = 'skipped';
    value.projects![0] = { ...project, status: 'In Process' };
    expect(queueProjects(value)[0].status).toBe('In Process');
  });
  it('preserves a human Reviewed status over historical automatic delivery status', () => {
    const value = state('running', 'retry');
    value.batch!.entries[0].status = 'done';
    value.projects![0] = { ...project, status: 'Reviewed' };
    expect(queueProjects(value)[0].status).toBe('Reviewed');
  });
  it('shows discovery while a retry is finding sources, never its old skipped attempt', () => {
    expect(projectSession(state('running'), project)?.status).toBe('discovering');
  });
  it('shows the current batch attempt rather than its historical skip', () => {
    expect(projectSession(state('running', 'retry'), project)).toBe(retry);
    expect(queueProjects(state('running', 'retry'))[0].status).toBe('In Process');
  });
  it('shows a new pending retry without the previous skip', () => {
    expect(projectSession(state('pending'), project)).toBeUndefined();
    expect(queueProjects(state('pending'))[0].status).toBe('To Do');
  });
  it('uses the newest session outside a batch, scoped to its studio', () => {
    expect(projectSession({ sessions: [old, retry, { ...retry, id: 'other', studio: 'screenbridge' }] }, project)).toBe(retry);
  });
});
