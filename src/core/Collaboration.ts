import { App, TFile, requestUrl, Notice } from 'obsidian';
import { TeamPluginSettings } from '../types';

export interface CollabFileMeta {
    id: string;
    path: string;
    version: number;
    lastEditorId: string;
    lastEditorName: string;
    updatedAt: number;
    createdAt: number;
    contentLength: number;
}

export interface CollabFile extends CollabFileMeta {
    content: string;
}

export interface ConflictInfo {
    localContent: string;
    serverFile: CollabFile;
}

export class Collaboration {
    private app: App;
    private settings: TeamPluginSettings;

    /** Track local file versions we've synced (path → version) */
    private syncedVersions: Map<string, number> = new Map();

    constructor(app: App, settings: TeamPluginSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: TeamPluginSettings): void {
        this.settings = settings;
    }

    private getApiUrl(path: string): string {
        return `${this.settings.serverUrl}${path}`;
    }

    private getHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.settings.apiKey}`,
            'X-User-Id': this.settings.userId || '',
        };
    }

    /**
     * List all collaborative files for the current team
     */
    async listFiles(teamId: string): Promise<CollabFileMeta[]> {
        try {
            const response = await requestUrl({
                url: this.getApiUrl(`/api/collab/${teamId}/files`),
                method: 'GET',
                headers: this.getHeaders(),
            });
            return response.json as CollabFileMeta[];
        } catch (e: any) {
            console.error('[Collab] listFiles error:', e);
            throw new Error(`获取文件列表失败: ${e.message}`);
        }
    }

    /**
     * Pull (download) a file from the server
     */
    async pullFile(teamId: string, fileId: string): Promise<CollabFile> {
        try {
            const response = await requestUrl({
                url: this.getApiUrl(`/api/collab/${teamId}/files/${fileId}`),
                method: 'GET',
                headers: this.getHeaders(),
            });
            const file = response.json as CollabFile;
            // Track synced version
            this.syncedVersions.set(file.path, file.version);
            return file;
        } catch (e: any) {
            console.error('[Collab] pullFile error:', e);
            throw new Error(`下载文件失败: ${e.message}`);
        }
    }

    /**
     * Push (upload) a local file to the server
     * Returns the file on success, or throws with ConflictInfo if conflict
     */
    async pushFile(teamId: string, file: TFile): Promise<CollabFileMeta> {
        const content = await this.app.vault.read(file);
        const clientVersion = this.syncedVersions.get(file.path);

        try {
            const response = await requestUrl({
                url: this.getApiUrl(`/api/collab/${teamId}/files`),
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({
                    path: file.path,
                    content,
                    clientVersion,
                }),
            });
            const result = response.json as CollabFileMeta;
            this.syncedVersions.set(file.path, result.version);
            return result;
        } catch (e: any) {
            // Check if this is a 409 conflict
            if (e.message?.includes('409')) {
                // requestUrl throws on non-2xx, try to parse conflict data from the error
                throw new Error('VERSION_CONFLICT');
            }
            console.error('[Collab] pushFile error:', e);
            throw new Error(`上传文件失败: ${e.message}`);
        }
    }

    /**
     * Sync a file: push local content, handle conflicts
     * Returns: 'synced' | 'conflict'
     */
    async syncFile(teamId: string, file: TFile): Promise<{ status: 'synced' | 'conflict'; conflict?: ConflictInfo }> {
        const localContent = await this.app.vault.read(file);

        try {
            await this.pushFile(teamId, file);
            return { status: 'synced' };
        } catch (e: any) {
            if (e.message === 'VERSION_CONFLICT') {
                // Fetch latest server file for conflict resolution
                const files = await this.listFiles(teamId);
                const serverMeta = files.find(f => f.path === file.path);
                if (serverMeta) {
                    const serverFile = await this.pullFile(teamId, serverMeta.id);
                    return {
                        status: 'conflict',
                        conflict: {
                            localContent,
                            serverFile,
                        },
                    };
                }
            }
            throw e;
        }
    }

    /**
     * Pull a file from server and save to local vault
     */
    async pullAndSave(teamId: string, fileId: string): Promise<TFile> {
        const serverFile = await this.pullFile(teamId, fileId);

        // Check if local file exists
        let localFile = this.app.vault.getAbstractFileByPath(serverFile.path);

        if (localFile instanceof TFile) {
            await this.app.vault.modify(localFile, serverFile.content);
            return localFile;
        } else {
            // Ensure parent folder exists
            const parts = serverFile.path.split('/');
            if (parts.length > 1) {
                const folderPath = parts.slice(0, -1).join('/');
                const folder = this.app.vault.getAbstractFileByPath(folderPath);
                if (!folder) {
                    await this.app.vault.createFolder(folderPath);
                }
            }
            const newFile = await this.app.vault.create(serverFile.path, serverFile.content);
            return newFile;
        }
    }

    /**
     * Force push: overwrite server version (used after conflict resolution)
     */
    async forcePush(teamId: string, file: TFile): Promise<CollabFileMeta> {
        const content = await this.app.vault.read(file);

        try {
            const response = await requestUrl({
                url: this.getApiUrl(`/api/collab/${teamId}/files`),
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({
                    path: file.path,
                    content,
                    // No clientVersion → no conflict check
                }),
            });
            const result = response.json as CollabFileMeta;
            this.syncedVersions.set(file.path, result.version);
            return result;
        } catch (e: any) {
            throw new Error(`强制推送失败: ${e.message}`);
        }
    }

    /**
     * Delete a collaborative file from the server
     */
    async deleteFile(teamId: string, fileId: string): Promise<void> {
        try {
            await requestUrl({
                url: this.getApiUrl(`/api/collab/${teamId}/files/${fileId}`),
                method: 'DELETE',
                headers: this.getHeaders(),
            });
            // Clean up local tracking
        } catch (e: any) {
            throw new Error(`删除失败: ${e.message}`);
        }
    }
}
