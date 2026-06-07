import { ItemView, WorkspaceLeaf, Menu, Notice, requestUrl, TFile, MarkdownView, FuzzySuggestModal } from 'obsidian';
import type TeamPlugin from '../main';
import { Team, TeamMember } from '../types/team';
import { TeamDocument } from '../types/document';
import { CreateTeamModal } from './CreateTeamModal';
import { InviteMemberModal } from './InviteMemberModal';
import { LoginModal } from './LoginModal';
import { HistoryModal } from './HistoryModal';
export const TEAM_VIEW_TYPE = 'team-view';

export class TeamView extends ItemView {
    private plugin: TeamPlugin;
    private currentTeam: Team | null = null;
    private teamDocs: TeamDocument[] = [];
    private teamWs: WebSocket | null = null;
    private teamWsTeamId: string | null = null;
    private isDisconnectingWs = false;
    private renderInProgress = false;

    constructor(leaf: WorkspaceLeaf, plugin: TeamPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return TEAM_VIEW_TYPE;
    }

    getDisplayText(): string {
        return '团队协作';
    }

    getIcon(): string {
        return 'users';
    }

    async onOpen() {
        await this.render();
    }

    async onClose() {
        this.disconnectTeamWebSocket();
    }

    /** 获取团队事件 WebSocket 地址（从 wsUrl 或 serverUrl 推导） */
    private getTeamWebSocketUrl(): string {
        let base: string;
        if (this.plugin.settings.wsUrl?.trim()) {
            const ws = this.plugin.settings.wsUrl.trim();
            base = ws.includes('/ws/collab') ? ws.replace(/\/ws\/collab\/?$/, '/ws/collab/team') : ws.replace(/\/+$/, '') + '/ws/collab/team';
        } else {
            const httpUrl = this.plugin.settings.serverUrl.replace(/\/+$/, '');
            base = httpUrl.replace(/^http/, 'ws') + '/ws/collab/team';
        }
        return base;
    }

    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    private logTeamWs(action: string, detail?: Record<string, unknown>): void {
        const entry = { time: new Date().toISOString(), interface: 'ws/team', action, ...detail };
        console.log(`[TeamCollab] ${JSON.stringify(entry)}`);
    }

    /** 连接团队事件 WebSocket，收到 team_drive_changed 时自动刷新 */
    private connectTeamWebSocket(): void {
        if (!this.currentTeam || !this.plugin.settings.apiKey) return;
        // 已连接同一团队时不再重复连接，避免 render 导致反复断开重连
        if (this.teamWs?.readyState === WebSocket.OPEN && this.teamWsTeamId === this.currentTeam.id) return;
        this.disconnectTeamWebSocket();

        const baseUrl = this.getTeamWebSocketUrl();
        let wsUrl: string;
        try {
            const url = new URL(baseUrl);
            url.searchParams.set('token', this.plugin.settings.apiKey);
            url.searchParams.set('teamId', this.currentTeam.id);
            wsUrl = url.toString();
        } catch (e) {
            this.logTeamWs('connect_fail', { reason: 'URL 解析失败', error: String(e) });
            return;
        }

        const tryConnect = () => {
            if (!this.currentTeam || !this.plugin.settings.apiKey) return;
            this.logTeamWs('connect', { teamId: this.currentTeam!.id, url: baseUrl });
            try {
                const ws = new WebSocket(wsUrl);
                ws.onopen = () => {
                    this.reconnectTimer = null;
                    this.teamWsTeamId = this.currentTeam?.id ?? null;
                    this.logTeamWs('connected', { teamId: this.currentTeam!.id });
                };
                ws.onmessage = async (ev) => {
                    try {
                        const data = JSON.parse(ev.data as string);
                        if (data?.type === 'team_drive_changed') {
                            const deleted: string[] = data.deleted ?? [];
                            const renamed: Array<{ from: string; to: string }> = data.renamed ?? [];
                            this.logTeamWs('message', { type: 'team_drive_changed', deleted, renamed });
                            for (const path of deleted) {
                                const file = this.app.vault.getAbstractFileByPath(path);
                                if (file && file instanceof TFile) {
                                    try {
                                        await this.app.vault.delete(file);
                                    } catch {
                                        // 文件可能已被删除或路径已变更，忽略 ENOENT
                                    }
                                }
                            }
                            for (const { from, to } of renamed) {
                                const file = this.app.vault.getAbstractFileByPath(from);
                                if (file && file instanceof TFile) {
                                    try {
                                        this.plugin.pendingRemoteRenames.add(from);
                                        await this.app.vault.rename(file, to);
                                    } catch {
                                        this.plugin.pendingRemoteRenames.delete(from);
                                        // 重命名失败时忽略
                                    }
                                }
                            }
                            this.render();
                        }
                    } catch {
                        // ignore
                    }
                };
                ws.onclose = (ev) => {
                    this.teamWs = null;
                    const hint = ev.code === 1006 ? ' (可能原因: 代理/防火墙未转发 WebSocket、服务未启、SSL 证书问题)' : '';
                    this.logTeamWs('close', {
                        code: ev.code,
                        reason: (ev.reason || '') + hint,
                        clean: ev.wasClean,
                    });
                    // 4001 = 未授权（token 过期），触发自动登出
                    if (ev.code === 4001) {
                        this.plugin.handleAuthExpired();
                        return;
                    }
                    if (!this.isDisconnectingWs) this.scheduleReconnect();
                };
                ws.onerror = () => {
                    this.teamWs = null;
                    this.logTeamWs('error', { teamId: this.currentTeam!.id });
                    if (!this.isDisconnectingWs) this.scheduleReconnect();
                };
                this.teamWs = ws;
            } catch (e) {
                this.logTeamWs('connect_fail', { reason: 'new WebSocket 异常', error: String(e) });
                this.scheduleReconnect();
            }
        };

        tryConnect();
    }

    /** 断线后延迟重连（非轮询，仅重连 WebSocket） */
    private scheduleReconnect(): void {
        if (this.reconnectTimer || !this.currentTeam || !this.plugin.settings.apiKey) return;
        this.logTeamWs('reconnect_schedule', { delayMs: 3000 });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectTeamWebSocket();
        }, 3000);
    }

    /** 断开团队事件 WebSocket */
    private disconnectTeamWebSocket(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.isDisconnectingWs = true;
        this.teamWsTeamId = null;
        if (this.teamWs) {
            this.logTeamWs('disconnect');
            this.teamWs.close();
            this.teamWs = null;
        }
        setTimeout(() => { this.isDisconnectingWs = false; }, 0);
    }

    async render() {
        // 防止「新建文档」等操作触发多次 render（本地回调 + WebSocket 推送）并发执行导致 UI 重复
        if (this.renderInProgress) return;
        this.renderInProgress = true;
        try {
            await this.doRender();
        } finally {
            this.renderInProgress = false;
        }
    }

    private async doRender() {
        const container = this.contentEl;
        container.empty();
        container.addClass('team-view');

        // Header
        const header = container.createDiv('team-view-header');
        header.createEl('h4', { text: '团队协作' });
        const currentUserEl = header.createEl('p', { cls: 'team-current-user' });
        currentUserEl.textContent = `当前用户: ${this.plugin.settings.username || '未设置'}`;

        // Check login status — validate token against server
        if (!this.plugin.settings.apiKey) {
            this.renderLoginPrompt(container);
            return;
        }

        // Verify token is still valid
        const isValid = await this.validateSession();
        if (!isValid) {
            // Stale token — clear saved auth and show login
            this.plugin.settings.apiKey = '';
            this.plugin.settings.userId = '';
            this.plugin.settings.username = '';
            await this.plugin.saveSettings();
            this.renderLoginPrompt(container);
            return;
        }

        // Team selector
        await this.renderTeamSelector(container);

        if (this.currentTeam) {
            // Members section
            this.renderMembers(container);

            // Team Drive documents section
            await this.renderTeamDrive(container);

            // Actions section
            this.renderActions(container);

            // 订阅团队事件 WebSocket：他人删除/新增共享文档时，实时推送并刷新
            this.connectTeamWebSocket();
        } else {
            this.disconnectTeamWebSocket();
            container.createEl('p', {
                text: '请选择或创建一个团队',
                cls: 'team-view-empty'
            });
        }
    }

    /**
     * Validate saved token against the server.
     * Returns true if token is valid and user exists.
     */
    private async validateSession(): Promise<boolean> {
        try {
            const response = await requestUrl({
                url: `${this.plugin.settings.serverUrl}/api/auth/me`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.plugin.settings.apiKey}`,
                    'X-User-Id': this.plugin.settings.userId || '',
                },
            });
            return response.status === 200 && !!response.json?.id;
        } catch {
            return false;
        }
    }

    private renderLoginPrompt(container: Element) {
        const loginDiv = container.createDiv('team-login-prompt');
        loginDiv.createEl('p', { text: '请先登录以使用团队协作功能' });

        const loginBtn = loginDiv.createEl('button', {
            text: '登录 / 注册',
            cls: 'action-btn'
        });
        loginBtn.addEventListener('click', () => {
            new LoginModal(this.app, this.plugin, () => this.render()).open();
        });

        // Show logged-in user
        if (this.plugin.settings.username) {
            loginDiv.createEl('p', {
                text: `当前用户: ${this.plugin.settings.username}`,
                cls: 'current-user'
            });
        }
    }

    private async renderTeamSelector(container: Element) {
        // 拉取当前用户的邀请
        try {
            const invitations = await this.plugin.teamManager.getMyInvitations();
            if (invitations && invitations.length > 0) {
                const inviteDiv = container.createDiv('team-invitations');
                inviteDiv.createEl('h5', { text: `📬 你有 ${invitations.length} 个待处理邀请` });

                for (const inv of invitations) {
                    const item = inviteDiv.createDiv('invitation-item');
                    const teamLabel = inv.teamName || inv.teamId.substring(0, 8);
                    const inviterLabel = inv.inviterName || '未知';
                    item.createEl('span', { text: `${inviterLabel} 邀请你加入「${teamLabel}」(${inv.role === 'member' ? '成员' : inv.role === 'admin' ? '管理员' : inv.role})` });

                    const actions = item.createDiv('invitation-actions');
                    const acceptBtn = actions.createEl('button', { text: '✅ 接受', cls: 'action-btn accept-btn' });
                    const rejectBtn = actions.createEl('button', { text: '❌ 拒绝', cls: 'action-btn reject-btn' });

                    acceptBtn.addEventListener('click', async () => {
                        try {
                            const newTeam = await this.plugin.teamManager.acceptInvitation(inv.id);
                            new Notice(`✅ 已成功加入团队: ${newTeam.name}`);
                            this.plugin.settings.currentTeamId = newTeam.id;
                            await this.plugin.saveSettings();
                            this.currentTeam = newTeam;
                            this.plugin.teamManager.setCurrentTeam(newTeam);
                            await this.render();
                        } catch {
                            new Notice(`接受邀请失败，可能已过期或已处理`);
                            await this.render(); // 刷新清理无效邀请
                        }
                    });

                    rejectBtn.addEventListener('click', async () => {
                        try {
                            await this.plugin.teamManager.rejectInvitation(inv.id);
                            new Notice('已拒绝邀请');
                            await this.render();
                        } catch {
                            new Notice(`拒绝邀请失败，可能已过期或已处理`);
                            await this.render(); // 刷新清理无效邀请
                        }
                    });
                }
            }
        } catch (e) {
            console.error('Failed to load invitations:', e);
        }

        const selectorDiv = container.createDiv('team-selector');
        const select = selectorDiv.createEl('select', { cls: 'team-select' });
        select.createEl('option', { text: '选择团队...', value: '' });

        try {
            const teams = await this.plugin.teamManager.getMyTeams();

            for (const team of teams) {
                const option = select.createEl('option', {
                    text: team.name,
                    value: team.id,
                });

                if (team.id === this.plugin.settings.currentTeamId) {
                    option.selected = true;
                    this.currentTeam = team;
                    this.plugin.teamManager.setCurrentTeam(team);
                }
            }
        } catch (e) {
            console.error('Failed to load teams:', e);
        }

        select.addEventListener('change', async () => {
            this.plugin.settings.currentTeamId = select.value;
            await this.plugin.saveSettings();

            if (select.value) {
                this.currentTeam = await this.plugin.teamManager.getTeam(select.value);
                this.plugin.teamManager.setCurrentTeam(this.currentTeam);
            } else {
                this.currentTeam = null;
                this.plugin.teamManager.setCurrentTeam(null);
            }

            await this.render();
        });

        // Create team button
        const createBtn = selectorDiv.createEl('button', {
            text: '+',
            cls: 'team-create-btn',
            attr: { title: '创建新团队' }
        });

        createBtn.addEventListener('click', () => {
            new CreateTeamModal(this.app, this.plugin).open();
        });
    }

    private renderMembers(container: Element) {
        if (!this.currentTeam) return;

        const membersDiv = container.createDiv('team-members');
        membersDiv.createEl('h5', { text: '团队成员' });

        const memberList = membersDiv.createEl('ul', { cls: 'member-list' });

        for (const member of this.currentTeam.members) {
            const li = memberList.createEl('li', { cls: 'member-item' });

            // Avatar
            const avatar = li.createDiv('member-avatar');
            avatar.textContent = member.username.charAt(0).toUpperCase();

            // Info
            const info = li.createDiv('member-info');
            info.createEl('span', { text: member.username, cls: 'member-name' });
            info.createEl('span', { text: this.getRoleText(member.role), cls: 'member-role' });

            // Context menu
            li.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showMemberMenu(e, member);
            });
        }

        // Invite button
        if (this.plugin.teamManager.hasPermission('manage_members')) {
            const inviteBtn = membersDiv.createEl('button', {
                text: '邀请成员',
                cls: 'team-invite-btn'
            });

            inviteBtn.addEventListener('click', () => {
                if (this.currentTeam) {
                    new InviteMemberModal(this.app, this.plugin, this.currentTeam.id).open();
                }
            });
        }
    }

    private async renderTeamDrive(container: Element) {
        if (!this.currentTeam) return;

        const driveDiv = container.createDiv('team-drive');
        driveDiv.createEl('h5', { text: '团队文件库 📁' });

        // Add "New Document" button
        const newBtn = driveDiv.createEl('button', {
            text: '+ 新建文档',
            cls: 'team-new-doc-btn'
        });
        newBtn.addEventListener('click', async () => {
            const filename = `未命名文档-${Date.now()}.md`;
            const teamPrefix = `团队云盘/${this.currentTeam!.name}`;
            const fullPath = `${teamPrefix}/${filename}`;
            try {
                await this.plugin.teamManager.createTeamDocument(this.currentTeam!.id, fullPath);
                new Notice(`已在云端创建文档: ${filename}`);
                this.render(); // refresh list
            } catch (e: any) {
                new Notice(`创建云文档失败: ${e.message}`);
            }
        });

        // Add "Upload Local File" button
        const uploadBtn = driveDiv.createEl('button', {
            text: '📤 上传本地文件',
            cls: 'team-upload-doc-btn'
        });
        uploadBtn.addEventListener('click', () => {
            this.showLocalFilePicker();
        });

        try {
            this.teamDocs = await this.plugin.teamManager.getTeamDocuments(this.currentTeam.id);

            // 新文件自动出现在左侧团队云盘：为云端有但本地无的文档创建空文件
            const teamPrefix = `团队云盘/${this.currentTeam.name}`;
            for (const doc of this.teamDocs) {
                if (!this.app.vault.getAbstractFileByPath(doc.path)) {
                    if (!this.app.vault.getAbstractFileByPath('团队云盘')) {
                        await this.app.vault.createFolder('团队云盘');
                    }
                    if (!this.app.vault.getAbstractFileByPath(teamPrefix)) {
                        await this.app.vault.createFolder(teamPrefix);
                    }
                    await this.app.vault.create(doc.path, '');
                }
            }

            if (this.teamDocs.length === 0) {
                driveDiv.createEl('p', { text: '云盘是空的', cls: 'empty-message' });
            } else {
                const docList = driveDiv.createEl('ul', { cls: 'doc-list' });

                for (const doc of this.teamDocs) {
                    const li = docList.createEl('li', { cls: 'doc-item' });

                    const leftDiv = li.createDiv({ cls: 'doc-item-left' });
                    const icon = leftDiv.createSpan({ cls: 'doc-icon' });
                    icon.textContent = '📄 ';
                    const filename = doc.path.split('/').pop() || doc.path;
                    leftDiv.createSpan({ text: filename, cls: 'doc-title' });

                    const rightDiv = li.createDiv({ cls: 'doc-item-right' });
                    if (doc.lastEditorName) {
                        rightDiv.createSpan({ text: `最后由 ${doc.lastEditorName} 编辑`, cls: 'doc-editor' });
                    }

                    // History button
                    const historyBtn = rightDiv.createEl('button', { text: '🕒', cls: 'doc-hist-btn' });
                    historyBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        // Open History Modal
                        new HistoryModal(this.app, this.plugin, this.currentTeam!.id, doc.id, doc.path).open();
                    });

                    // Delete button
                    const delBtn = rightDiv.createEl('button', { text: '🗑️', cls: 'doc-del-btn' });
                    delBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        try {
                            // 如果当前正在协同该文件，先停止协同（否则服务端会拒绝删除）
                            if (this.plugin.collabEditor.isActive && this.plugin.collabEditor.activeFilePath === doc.path) {
                                this.plugin.collabEditor.stopCollab();
                            }
                            await this.plugin.teamManager.deleteTeamDocument(this.currentTeam!.id, doc.id);
                            // 同步删除本地 vault 文件
                            const localFile = this.app.vault.getAbstractFileByPath(doc.path);
                            if (localFile && localFile instanceof TFile) {
                                await this.app.vault.delete(localFile);
                            }
                            new Notice('已从云端删除此文件');
                            this.render();
                        } catch (err: any) {
                            new Notice(err?.message ?? `删除失败: ${err}`);
                        }
                    });

                    // 点击时自动与本地目录挂钩，并抛给 Obsidian 的文件系统去开启
                    li.addEventListener('click', async () => {
                        const teamPrefix = `团队云盘/${this.currentTeam!.name}`;
                        const localPath = doc.path;

                        let file = this.app.vault.getAbstractFileByPath(localPath);
                        if (!file) {
                            // Ensure folder exists
                            if (!this.app.vault.getAbstractFileByPath('团队云盘')) {
                                await this.app.vault.createFolder('团队云盘');
                            }
                            if (!this.app.vault.getAbstractFileByPath(teamPrefix)) {
                                await this.app.vault.createFolder(teamPrefix);
                            }
                            // Create empty file (Yjs engine will fill the content as soon as it opens)
                            file = await this.app.vault.create(localPath, '');
                        }

                        await this.app.workspace.openLinkText(localPath, '', false);
                        new Notice(`正在为您接入团队文档...`);
                    });
                }
            }
        } catch (e) {
            console.error('Failed to load team docs:', e);
            driveDiv.createEl('p', { text: '加载云盘失败', cls: 'error-message' });
        }
    }

    private renderActions(container: Element) {
        const actionsDiv = container.createDiv('team-actions');

        // Sync plugins button
        const syncBtn = actionsDiv.createEl('button', {
            text: '同步插件',
            cls: 'action-btn'
        });
        syncBtn.addEventListener('click', async () => {
            await this.plugin.syncTeamPlugins();
        });

        // Generate report button
        const reportBtn = actionsDiv.createEl('button', {
            text: '生成报告',
            cls: 'action-btn'
        });
        reportBtn.addEventListener('click', () => {
            this.plugin.openReportModal();
        });
    }

    private getRoleText(role: string): string {
        const roleMap: Record<string, string> = {
            'owner': '所有者',
            'admin': '管理员',
            'member': '成员',
            'viewer': '访客'
        };
        return roleMap[role] || role;
    }

    private showMemberMenu(event: MouseEvent, member: TeamMember) {
        const menu = new Menu();

        if (this.plugin.teamManager.hasPermission('manage_members') &&
            member.userId !== this.plugin.settings.userId) {
            menu.addItem(item => item
                .setTitle('移除成员')
                .setIcon('user-minus')
                .onClick(async () => {
                    if (this.currentTeam) {
                        await this.plugin.teamManager.removeMember(this.currentTeam.id, member.userId);
                        await this.render();
                    }
                })
            );
        }

        menu.showAtMouseEvent(event);
    }

    /**
     * 弹出本地文件选择器，让用户选取已有的 .md 文件上传到团队云盘
     */
    private showLocalFilePicker() {
        if (!this.currentTeam) return;
        const team = this.currentTeam;
        const teamPrefix = `团队云盘/${team.name}`;

        // 收集 vault 中所有 .md 文件（排除已在团队云盘目录下的）
        const allFiles = this.app.vault.getMarkdownFiles().filter(f => !f.path.startsWith('团队云盘/'));

        if (allFiles.length === 0) {
            new Notice('没有找到可上传的本地 Markdown 文件');
            return;
        }

        // 使用 Obsidian 的 FuzzySuggestModal 供用户搜索选择
        const modal = new LocalFileSuggestModal(this.app, allFiles, async (file: TFile) => {
            try {
                const content = await this.app.vault.read(file);
                const cloudPath = `${teamPrefix}/${file.name}`;

                // 上传到服务端
                await this.plugin.teamManager.createTeamDocument(team.id, cloudPath, content);

                // 确保本地云盘目录存在
                if (!this.app.vault.getAbstractFileByPath('团队云盘')) {
                    await this.app.vault.createFolder('团队云盘');
                }
                if (!this.app.vault.getAbstractFileByPath(teamPrefix)) {
                    await this.app.vault.createFolder(teamPrefix);
                }

                // 把本地文件移动到云盘目录（如果目标不存在的话）
                if (!this.app.vault.getAbstractFileByPath(cloudPath)) {
                    await this.app.vault.rename(file, cloudPath);
                }

                new Notice(`✅ 已将「${file.name}」上传到团队云盘`);
                await this.render();
            } catch (e: any) {
                new Notice(`上传失败: ${e.message}`);
            }
        });
        modal.open();
    }
}

/**
 * 本地文件模糊搜索弹窗
 */
class LocalFileSuggestModal extends FuzzySuggestModal<TFile> {
    private files: TFile[];
    private onChoose: (file: TFile) => void;

    constructor(app: any, files: TFile[], onChoose: (file: TFile) => void) {
        super(app);
        this.files = files;
        this.onChoose = onChoose;
        this.setPlaceholder('搜索并选择要上传的本地文件...');
    }

    getItems(): TFile[] {
        return this.files;
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile): void {
        this.onChoose(item);
    }
}
