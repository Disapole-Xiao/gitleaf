import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DEFAULT_SERVER } from '../consts';
import { serverUrl } from './credentials';
export type ProjectMode = 'online' | 'offline';
export interface ProjectSettings {
    serverUrl: string;
    projectId: string;
    projectName: string;
    mainTex?: string;
    mainPdf?: string;
    autoSync: boolean;
    mode: ProjectMode;
    lastSynced?: string;
}
/** Atomic replacement prevents other processes reading partially written JSON. */
export async function writeJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        await fs.rename(temporary, file);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}
export class ProjectStore {
    protected settings?: ProjectSettings;
    readonly root: string;
    readonly metadataDir: string;
    readonly settingsPath: string;
    constructor(root: string) {
        this.root = path.resolve(root);
        this.metadataDir = path.join(this.root, '.gitleaf');
        this.settingsPath = path.join(this.metadataDir, 'settings.json');
    }
    async load(): Promise<ProjectSettings | undefined> {
        let content: string;
        try {
            content = await fs.readFile(this.settingsPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            this.settings = undefined;
            return;
        }
        const data = JSON.parse(content) as ProjectSettings;
        if (
            !data.projectId ||
            !data.projectName ||
            !['online', 'offline'].includes(data.mode) ||
            typeof data.autoSync !== 'boolean'
        )
            throw new Error('Invalid .gitleaf/settings.json.');
        return (this.settings = { ...data, serverUrl: serverUrl(data.serverUrl) });
    }
    getSettings(): ProjectSettings | undefined {
        return this.settings;
    }
    async isLinked(): Promise<boolean> {
        return !!(await this.load());
    }
    async save(settings: ProjectSettings): Promise<void> {
        await writeJson(this.settingsPath, settings);
        this.settings = settings;
    }
    async update(changes: Partial<ProjectSettings>): Promise<void> {
        const settings = await this.load();
        if (!settings) throw new Error('Link an Overleaf project first.');
        await this.save({ ...settings, ...changes });
    }
    async clear(): Promise<void> {
        await fs.rm(this.settingsPath, { force: true });
        this.settings = undefined;
    }
    async updateLastSynced(): Promise<void> {
        await this.update({ lastSynced: new Date().toISOString() });
    }
    file(relative: string): string {
        const result = path.resolve(this.root, relative.replace(/^[/\\]+/, '')),
            inside = path.relative(this.root, result);
        if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside))
            throw new Error('Path escapes the linked folder.');
        return result;
    }
    static createDefaultSettings(
        server: string,
        projectId: string,
        projectName: string,
        mode: ProjectMode,
    ): ProjectSettings {
        return {
            serverUrl: serverUrl(server || DEFAULT_SERVER),
            projectId,
            projectName,
            mode,
            autoSync: mode === 'online',
            mainTex: 'main.tex',
            mainPdf: 'main.pdf',
        };
    }
}
