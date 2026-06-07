import { Plugin, TFile, TAbstractFile, Notice, WorkspaceLeaf } from 'obsidian';
import { TeamPluginSettings, DEFAULT_SETTINGS } from './types';
import { JwtPayload } from './utils/api';
import { TeamPluginSettingTab } from './settings';
import { TeamManager, PluginSync, Collaboration, CollabEditor } from './core';
import { Summarizer } from './ai';
import { DailyReport, MonthlyReport } from './reports';
import { ReportModal, TeamView, TEAM_VIEW_TYPE, LoginModal, CreateTeamModal } from './ui';

export default class TeamPlugin extends Plugin {
    settings: TeamPluginSettings;

    // Core modules
    teamManager: TeamManager;
    pluginSync: PluginSync;
    summarizer: Summarizer;
    collaboration: Collaboration;
    collabEditor: CollabEditor;

    // Report generators
    dailyReport: DailyReport;
    monthlyReport: MonthlyReport;

    /** 由 WebSocket 触发的重命名，避免再次同步到云端造成循环 */
    pendingRemoteRenames = new Set<string>();

    async onload() {
        console.log('Loading Team Collaboration Plugin');

        // Load settings
        await this.loadSettings();

        // Initialize modules
        this.initializeModules();

        // Register team drive auto mount
        this.setupTeamDriveAutoMount();

        // 监听团队云盘文件重命名，同步到云端
        this.setupTeamDriveRenameSync();

        // Register view
        this.registerView(
            TEAM_VIEW_TYPE,
            (leaf) => new TeamView(leaf, this)
        );

        // Add ribbon icon
        this.addRibbonIcon('users', '团队协作', () => {
            this.activateTeamView();
        });

        // Register commands
        this.registerCommands();

        // Add settings tab
        this.addSettingTab(new TeamPluginSettingTab(this.app, this));

        // Setup auto daily report
        this.setupAutoDailyReport();

        // Token 过期自动登出
        this.checkTokenExpiry();

        // 当 Yjs WebSocket 收到 4001 时自动登出
        this.collabEditor.onAuthFailed = () => this.handleAuthExpired();
    }

    onunload() {
        console.log('Unloading Team Collaboration Plugin');
    }

    async loadSettings() {
        const saved = await this.loadData() as Partial<TeamPluginSettings> | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
    }

    /**
     * 解码 JWT payload（不验证签名），检查 exp 是否已过期
     */
    private checkTokenExpiry(): void {
        const token = this.settings.apiKey;
        if (!token) return;
        try {
            const parts = token.split('.');
            if (parts.length !== 3) return;
            const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as JwtPayload;
            if (payload.exp && payload.exp * 1000 < Date.now()) {
                console.warn('[Auth] JWT 已过期，自动登出');
                this.handleAuthExpired();
            }
        } catch {
            // token 格式异常，忽略
        }
    }

    /**
     * 登录态失效时统一处理：清空凭证、停止协同、提醒用户
     */
    async handleAuthExpired(): Promise<void> {
        // 避免重复触发
        if (!this.settings.apiKey) return;
        this.settings.apiKey = '';
        this.settings.userId = '';
        this.settings.username = '';
        await this.saveSettings();
        if (this.collabEditor.isActive) {
            this.collabEditor.stopCollab();
        }
        new Notice('⚠️ 登录已过期，请重新登录');
        // 刷新团队面板
        this.app.workspace.getLeavesOfType(TEAM_VIEW_TYPE).forEach(leaf => {
            (leaf.view as TeamView).render();
        });
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.updateModules();
    }

    private initializeModules() {
        // Core
        this.teamManager = new TeamManager(this.app, this.settings);
        this.pluginSync = new PluginSync(this.app, this.settings);
        this.collaboration = new Collaboration(this.app, this.settings);
        this.collabEditor = new CollabEditor(this.app, this, this.settings);

        // AI
        this.summarizer = new Summarizer(this.app);
        this.summarizer.initProvider(this.settings);

        // Reports
        this.dailyReport = new DailyReport(this.app, this.settings, this.summarizer);
        this.monthlyReport = new MonthlyReport(this.app, this.settings, this.summarizer);
    }

    private updateModules() {
        this.teamManager.updateSettings(this.settings);
        this.pluginSync.updateSettings(this.settings);
        this.collaboration.updateSettings(this.settings);
        this.collabEditor.updateSettings(this.settings);
        this.summarizer.initProvider(this.settings);
        this.dailyReport.updateSettings(this.settings);
        this.monthlyReport.updateSettings(this.settings);
    }

    private setupTeamDriveRenameSync() {
        this.registerEvent(
            this.app.vault.on('rename', async (file: TAbstractFile, oldPath: string) => {
                if (!(file instanceof TFile) || !file.path.startsWith('团队云盘/') || !this.settings.apiKey) return;
                if (this.pendingRemoteRenames.has(oldPath)) {
                    this.pendingRemoteRenames.delete(oldPath);
                    return;
                }
                const parts = file.path.split('/');
                if (parts.length < 3) return;
                const teamName = parts[1];
                try {
                    const teams = await this.teamManager.getMyTeams();
                    const team = teams.find(t => t.name === teamName);
                    if (!team) return;
                    const docs = await this.teamManager.getTeamDocuments(team.id);
                    const doc = docs.find(d => d.path === oldPath);
                    if (!doc) return;
                    await this.teamManager.renameTeamDocument(team.id, doc.id, file.path);
                    new Notice('已同步重命名到云端');
                } catch (e) {
                    new Notice(e instanceof Error ? e.message : String(e));
                }
            })
        );
    }

    private setupTeamDriveAutoMount() {
        this.registerEvent(
            this.app.workspace.on('file-open', async (file: TFile | null) => {
                if (!file) {
                    if (this.collabEditor.isActive) {
                        this.collabEditor.stopCollab();
                    }
                    return;
                }

                if (file.path.startsWith('团队云盘/')) {
                    const parts = file.path.split('/');
                    if (parts.length >= 3) {
                        const teamName = parts[1];
                        try {
                            const teams = await this.teamManager.getMyTeams();
                            const team = teams.find(t => t.name === teamName);
                            if (team) {
                                // 只有通过插件分享过的文档才进入协同；手动创建的文件不在云端，不启动协同
                                const docs = await this.teamManager.getTeamDocuments(team.id);
                                const isShared = docs.some(d => d.path === file.path);
                                console.log('[AutoMount] 文件检查:', file.path, '云端匹配:', isShared, '云端文档数:', docs.length);
                                if (!isShared) return;

                                if (!this.collabEditor.isActive || this.collabEditor.activeFilePath !== file.path) {
                                    console.log('[AutoMount] 启动协同:', file.path);
                                    if (this.collabEditor.isActive) {
                                        this.collabEditor.stopCollab();
                                    }
                                    await this.collabEditor.startCollab(team.id, file);
                                } else {
                                    console.log('[AutoMount] 已在协同中，跳过:', file.path);
                                }
                            }
                        } catch (e) {
                            console.error('Auto-mount failed:', e);
                        }
                    }
                } else {
                    if (this.collabEditor.isActive) {
                        this.collabEditor.stopCollab();
                    }
                }
            })
        );
    }

    private registerCommands() {
        // Open team view
        this.addCommand({
            id: 'open-team-view',
            name: '打开团队视图',
            callback: () => {
                this.activateTeamView();
            }
        });

        // Generate daily report
        this.addCommand({
            id: 'generate-daily-report',
            name: '生成日报',
            callback: async () => {
                try {
                    const report = await this.dailyReport.generateTodayReport();
                    const file = await this.dailyReport.saveReport(report);
                    new Notice(`日报已生成: ${file.path}`);
                    this.app.workspace.openLinkText(file.path, '', true);
                } catch (e) {
                    new Notice(`生成日报失败: ${e}`);
                }
            }
        });

        // Generate monthly report
        this.addCommand({
            id: 'generate-monthly-report',
            name: '生成月报',
            callback: async () => {
                try {
                    const report = await this.monthlyReport.generateCurrentMonthReport();
                    const file = await this.monthlyReport.saveReport(report);
                    new Notice(`月报已生成: ${file.path}`);
                    this.app.workspace.openLinkText(file.path, '', true);
                } catch (e) {
                    new Notice(`生成月报失败: ${e}`);
                }
            }
        });

        // Summarize current file
        this.addCommand({
            id: 'summarize-current-file',
            name: 'AI 总结当前文档',
            editorCallback: async (editor, view) => {
                if (!view.file) return;

                if (!this.summarizer.isConfigured()) {
                    new Notice('请先配置 AI API');
                    return;
                }

                try {
                    new Notice('正在生成总结...');
                    const summary = await this.summarizer.summarizeFile(view.file, {
                        language: this.settings.language,
                    });

                    // Insert summary at cursor
                    editor.replaceSelection(`\n\n## AI 总结\n\n${summary}\n`);
                    new Notice('总结已插入');
                } catch (e) {
                    new Notice(`总结失败: ${e}`);
                }
            }
        });

        // Sync plugins from team
        this.addCommand({
            id: 'sync-team-plugins',
            name: '同步团队插件',
            callback: async () => {
                await this.syncTeamPlugins();
            }
        });

        // Show installed plugins
        this.addCommand({
            id: 'show-installed-plugins',
            name: '查看已安装插件列表',
            callback: async () => {
                const plugins = await this.pluginSync.getInstalledPlugins();
                const md = this.pluginSync.generatePluginListMarkdown(plugins);

                // Create temp file
                const filePath = 'plugins-list.md';
                const existingFile = this.app.vault.getAbstractFileByPath(filePath);
                if (existingFile) {
                    await this.app.vault.modify(existingFile as TFile, md);
                } else {
                    await this.app.vault.create(filePath, md);
                }

                this.app.workspace.openLinkText(filePath, '', true);
            }
        });

        // Open report modal
        this.addCommand({
            id: 'open-report-modal',
            name: '打开报告生成器',
            callback: () => {
                this.openReportModal();
            }
        });

        // Login / Register
        this.addCommand({
            id: 'login',
            name: '登录 / 注册',
            callback: () => {
                new LoginModal(this.app, this, () => this.activateTeamView()).open();
            }
        });

        // Create team
        this.addCommand({
            id: 'create-team',
            name: '创建团队',
            callback: () => {
                if (!this.settings.apiKey) {
                    new Notice('请先登录');
                    new LoginModal(this.app, this, () => this.activateTeamView()).open();
                    return;
                }
                new CreateTeamModal(this.app, this).open();
            }
        });
    }

    private setupAutoDailyReport() {
        if (!this.settings.autoGenerateDailyReport) return;

        // Check every minute
        this.registerInterval(
            window.setInterval(() => {
                const now = new Date();
                const [targetHour, targetMinute] = this.settings.dailyReportTime.split(':').map(Number);

                if (now.getHours() === targetHour && now.getMinutes() === targetMinute) {
                    this.dailyReport.generateTodayReport().then(async (report) => {
                        await this.dailyReport.saveReport(report);
                        new Notice('日报已自动生成');
                    }).catch(e => {
                        console.error('Auto daily report failed:', e);
                    });
                }
            }, 60000)
        );
    }

    async activateTeamView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(TEAM_VIEW_TYPE);

        if (leaves.length > 0) {
            leaf = leaves[0];
            // Force re-render existing TeamView (e.g. after login)
            const view = leaf.view;
            if (view instanceof TeamView) {
                await view.render();
            }
        } else {
            leaf = workspace.getRightLeaf(false);
            await leaf?.setViewState({ type: TEAM_VIEW_TYPE, active: true });
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    openReportModal() {
        new ReportModal(
            this.app,
            this.settings,
            this.dailyReport,
            this.monthlyReport
        ).open();
    }

    async syncTeamPlugins() {
        if (!this.settings.currentTeamId) {
            new Notice('请先选择一个团队');
            return;
        }

        try {
            new Notice('正在获取团队插件配置...');

            const syncPackage = await this.pluginSync.getTeamPluginConfig(this.settings.currentTeamId);
            const result = await this.pluginSync.installPluginsFromPackage(syncPackage);

            const message = [
                `同步完成:`,
                `✅ 已安装: ${result.installed.length}`,
                `⏭️ 已跳过: ${result.skipped.length}`,
                `❌ 失败: ${result.failed.length}`,
            ].join('\n');

            new Notice(message);
        } catch (e) {
            new Notice(`同步失败: ${e}`);
        }
    }
}
