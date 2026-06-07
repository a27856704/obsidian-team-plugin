// Team related types
export interface Team {
    id: string;
    name: string;
    description: string;
    ownerId: string;
    members: TeamMember[];
    createdAt: number;
    updatedAt: number;
    settings: TeamSettings;
}

export interface TeamMember {
    userId: string;
    username: string;
    email?: string;
    role: TeamRole;
    joinedAt: number;
    avatar?: string;
}

export type TeamRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface TeamSettings {
    allowMemberInvite: boolean;
    requireApproval: boolean;
    defaultDocumentPermission: DocumentPermission;
    syncPluginSettings: boolean;
}

export type DocumentPermission = 'read' | 'write' | 'admin';

export interface TeamInvitation {
    id: string;
    teamId: string;
    teamName: string;
    inviterId: string;
    inviterName: string;
    inviteeEmail: string;
    role: TeamRole;
    status: 'pending' | 'accepted' | 'rejected' | 'expired';
    createdAt: number;
    expiresAt: number;
}
