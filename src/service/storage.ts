import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig, Project, Session } from '../shared/contracts';
import { DEFAULT_CONFIG } from '../shared/defaults';

export interface PersistedData {
  config: AppConfig;
  projects: Project[];
  sessions: Session[];
  currentSessionId?: string;
}

const INITIAL: PersistedData = {
  config: DEFAULT_CONFIG,
  projects: [],
  sessions: [],
};

export class JsonStore {
  private file: string;
  private value: PersistedData = structuredClone(INITIAL);
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private directory: string) {
    this.file = path.join(directory, 'state.json');
  }

  async load(): Promise<PersistedData> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<PersistedData>;
      this.value = {
        config: {
          ...DEFAULT_CONFIG,
          ...raw.config,
          sourceRoots: { ...DEFAULT_CONFIG.sourceRoots, ...raw.config?.sourceRoots },
          destinationFolders: { ...DEFAULT_CONFIG.destinationFolders, ...raw.config?.destinationFolders },
        },
        projects: raw.projects ?? [],
        sessions: raw.sessions ?? [],
        currentSessionId: raw.currentSessionId,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this.value;
  }

  get(): PersistedData { return structuredClone(this.value); }

  async update(change: (state: PersistedData) => void): Promise<PersistedData> {
    // A failed disk write must not permanently poison later updates.
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const next = structuredClone(this.value);
      change(next);
      const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(temp, this.file);
      this.value = next;
    });
    await this.writeChain;
    return this.get();
  }
}
