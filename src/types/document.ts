// Document sharing related types
import { DocumentPermission } from './team';

export interface TeamDocument {
    id: string;
    path: string;
    version: number;
    lastEditorId?: string;
    lastEditorName?: string;
    createdAt: number;
    updatedAt: number;
    contentLength?: number;
}

export type { DocumentPermission };

export interface Attachment {
    id: string;
    name: string;
    path: string;
    mimeType: string;
    size: number;
    url?: string;
}

export interface DocumentSyncStatus {
    documentId: string;
    localPath: string;
    remotePath: string;
    localVersion: number;
    remoteVersion: number;
    status: 'synced' | 'local_ahead' | 'remote_ahead' | 'conflict';
    lastSyncedAt: number;
}

export interface ShareRequest {
    documentPath: string;
    teamId: string;
    permission: DocumentPermission;
    includeAttachments: boolean;
    includeLinkedDocs: boolean;
    includePluginConfig: boolean;
}

export interface PluginInfo {
    id: string;
    name: string;
    version: string;
    enabled: boolean;
    hasSettings: boolean;
}

export interface PluginSyncPackage {
    plugins: PluginInfo[];
    settings: Record<string, unknown>;
    timestamp: number;
}
