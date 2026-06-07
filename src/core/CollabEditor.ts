/**
 * CollabEditor - 实时协同编辑核心模块
 * 
 * 使用 Yjs (CRDT) + WebSocket + CodeMirror 6 绑定
 * 实现飞书/腾讯文档式的实时多人协同编辑
 */

import { App, Notice, TFile, Plugin } from 'obsidian';
import { TeamPluginSettings } from '../types';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { EditorView } from '@codemirror/view';
import { Compartment } from '@codemirror/state';
import { getMarkdownEditorView } from '../utils/obsidian';

/** 协同会话信息 */
interface CollabSession {
    ydoc: Y.Doc;
    provider: WebsocketProvider;
    file: TFile;
    roomName: string;
    cleanup: () => void;
}

/** 协同状态回调 */
export type CollabStatusCallback = (status: 'connecting' | 'connected' | 'disconnected', info?: string) => void;

export class CollabEditor {
    private app: App;
    private plugin: Plugin;
    private settings: TeamPluginSettings;
    private activeSession: CollabSession | null = null;
    private onStatusChange: CollabStatusCallback | null = null;
    public collabCompartment: Compartment;
    public onAuthFailed: (() => void) | null = null;

    constructor(app: App, plugin: Plugin, settings: TeamPluginSettings) {
        this.app = app;
        this.plugin = plugin;
        this.settings = settings;
        this.collabCompartment = new Compartment();
        // 全局注册 Compartment 占位符，以便在每个编辑器中都能动态注入
        this.plugin.registerEditorExtension(this.collabCompartment.of([]));
    }

    updateSettings(settings: TeamPluginSettings): void {
        this.settings = settings;
    }

    /** 设置状态回调 */
    setStatusCallback(callback: CollabStatusCallback) {
        this.onStatusChange = callback;
    }

    /** 获取当前是否有活跃的协同会话 */
    get isActive(): boolean {
        return this.activeSession !== null;
    }

    /** 获取当前协同的文件路径 */
    get activeFilePath(): string | null {
        return this.activeSession?.file.path || null;
    }

    /**
     * 开始协同编辑当前打开的文件
     */
    async startCollab(teamId: string, file: TFile): Promise<void> {
        // 如果已有会话，先停止
        if (this.activeSession) {
            this.stopCollab();
        }

        // 获取 WebSocket 地址
        const wsUrl = this.getWebSocketUrl();
        const roomName = `team:${teamId}:${file.path}`;

        this.onStatusChange?.('connecting', `正在连接协同...`);

        // 创建 Yjs 文档
        const ydoc = new Y.Doc();
        const ytext = ydoc.getText('codemirror');

        // 创建 WebSocket 连接
        console.log('[CollabEditor] WebSocket URL:', wsUrl, 'Room:', roomName);
        const provider = new WebsocketProvider(wsUrl, roomName, ydoc, {
            params: {
                token: this.settings.apiKey,
                room: roomName,
            },
            connect: true,
        });

        // 设置用户信息（用于远程光标显示）
        provider.awareness.setLocalStateField('user', {
            name: this.settings.username || '匿名',
            color: this.getRandomColor(),
            colorLight: this.getRandomColorLight(),
        });

        // 监听连接状态
        provider.on('status', (event: { status: string }) => {
            console.log('[CollabEditor] Provider 状态变更:', event.status);
            if (event.status === 'connected') {
                this.onStatusChange?.('connected', `协同编辑中: ${file.basename}`);
            } else if (event.status === 'disconnected') {
                this.onStatusChange?.('disconnected', '连接断开，正在重连...');
            }
        });

        provider.on('connection-error', (event: Event) => {
            console.error('[CollabEditor] WebSocket 连接错误:', event);
        });

        provider.on('connection-close', (event: CloseEvent | null) => {
            console.warn('[CollabEditor] WebSocket 连接关闭:', event?.code, event?.reason);
            if (event?.code === 4001 && this.onAuthFailed) {
                this.onAuthFailed();
            }
        });

        // 等待首次同步完成
        const syncResult = await new Promise<string>((resolve) => {
            if (provider.synced) {
                resolve('already_synced');
            } else {
                provider.once('sync', () => resolve('sync_event'));
            }
            // 5秒超时
            window.setTimeout(() => resolve('timeout'), 5000);
        });
        console.log('[CollabEditor] 同步结果:', syncResult, ', ytext.length=', ytext.length, ', provider.wsconnected=', provider.wsconnected);

        // 如果这是新文档（服务器上还没有内容），用本地内容初始化
        // 优先使用 EditorView 当前内容（含未保存编辑），否则用 vault 文件内容
        if (ytext.length === 0) {
            const editorView = this.getEditorView(file);
            const localContent = editorView
                ? editorView.state.doc.toString()
                : await this.app.vault.read(file);
            if (localContent.length > 0) {
                ytext.insert(0, localContent);
            }
        }

        // 等待编辑器完全渲染就绪（Obsidian 的 file-open 事件触发时 MarkdownView 可能还没初始化完成）
        await new Promise<void>(resolve => window.setTimeout(resolve, 600));

        console.log('[CollabEditor] 开始绑定编辑器, ytext.length=', ytext.length, ', provider.synced=', provider.synced);

        // 绑定到 CodeMirror 6 编辑器
        const cleanup = this.bindToEditor(file, ydoc, provider);

        this.activeSession = {
            ydoc,
            provider,
            file,
            roomName,
            cleanup,
        };

        new Notice(`🔗 开始协同编辑「${file.basename}」`);
    }

    /**
     * 停止协同编辑
     */
    stopCollab(): void {
        if (!this.activeSession) return;

        const fileName = this.activeSession.file.basename;

        // 清理编辑器绑定
        this.activeSession.cleanup();

        // 断开 WebSocket
        this.activeSession.provider.disconnect();
        this.activeSession.provider.destroy();
        this.activeSession.ydoc.destroy();

        this.activeSession = null;
        this.onStatusChange?.('disconnected', '已停止协同');

        new Notice(`❌ 已停止协同编辑「${fileName}」`);
    }

    /**
     * 绑定 Yjs 到当前打开文件的 CodeMirror 6 编辑器
     */
    private bindToEditor(file: TFile, ydoc: Y.Doc, provider: WebsocketProvider): () => void {
        const ytext = ydoc.getText('codemirror');
        const undoManager = new Y.UndoManager(ytext);
        let isCleaned = false;
        let retryTimer: number | null = null;

        const doInject = (editorView: EditorView) => {
            if (isCleaned) return;

            // 【强制对齐】挂载 yCollab 前必须确保 EditorState.doc 与 ytext 100% 一致
            const currentDoc = editorView.state.doc.toString();
            const ytextContent = ytext.toString();
            if (currentDoc !== ytextContent) {
                editorView.dispatch({
                    changes: { from: 0, to: currentDoc.length, insert: ytextContent }
                });
            }

            const collabExtension = yCollab(ytext, provider.awareness, { undoManager });
            editorView.dispatch({
                effects: this.collabCompartment.reconfigure(collabExtension)
            });
            console.log('[CollabEditor] yCollab 扩展已成功注入');
        };

        // 尝试获取 EditorView
        const editorView = this.getEditorView(file);
        console.log('[CollabEditor] 初次获取 EditorView:', editorView ? '✅ 成功' : '❌ 失败, 将重试');
        if (editorView) {
            doInject(editorView);
        } else {
            // 编辑器还没就绪，启动重试轮询
            console.warn('[CollabEditor] EditorView 首次获取失败，启动重试...');
            let retries = 0;
            const maxRetries = 15;
            const poll = () => {
                if (isCleaned) return;
                retries++;
                const ev = this.getEditorView(file);
                console.log(`[CollabEditor] 重试 #${retries} 获取 EditorView:`, ev ? '✅ 成功' : '❌ 失败');
                if (ev) {
                    doInject(ev);
                } else if (retries < maxRetries) {
                    retryTimer = window.setTimeout(poll, 300);
                } else {
                    console.error('[CollabEditor] 重试 ' + maxRetries + ' 次后仍无法获取 EditorView');
                }
            };
            retryTimer = window.setTimeout(poll, 300);
        }

        // 返回清理函数
        return () => {
            isCleaned = true;
            if (retryTimer) window.clearTimeout(retryTimer);
            try {
                // 找到当前活跃的 EditorView 来卸载扩展
                const ev = this.getEditorView(file);
                if (ev) {
                    ev.dispatch({
                        effects: this.collabCompartment.reconfigure([])
                    });
                }
            } catch {
                // Ignore if view is already destroyed
            }
            undoManager.destroy();
        };
    }

    /**
     * 获取文件对应的 CodeMirror 6 EditorView 实例
     */
    private getEditorView(file: TFile): EditorView | null {
        return getMarkdownEditorView(file, this.app);
    }

    /**
     * 获取 WebSocket 地址
     */
    private getWebSocketUrl(): string {
        // 优先使用插件中单独配置的 wsUrl
        if (this.settings.wsUrl) {
            return this.settings.wsUrl.trim();
        }

        // 未配置的情况下，尝试从常规的 serverUrl 自动推导
        const httpUrl = this.settings.serverUrl.replace(/\/+$/, '');
        const wsUrl = httpUrl.replace(/^http/, 'ws') + '/ws/collab';
        return wsUrl;
    }

    /** 随机颜色（用于远程光标） */
    private getRandomColor(): string {
        const colors = ['#30bced', '#6eeb83', '#ffbc42', '#e84855', '#8ac926', '#ff6b6b', '#4ecdc4', '#a06cd5'];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    private getRandomColorLight(): string {
        const colors = ['#30bced33', '#6eeb8333', '#ffbc4233', '#e8485533', '#8ac92633', '#ff6b6b33', '#4ecdc433', '#a06cd533'];
        return colors[Math.floor(Math.random() * colors.length)];
    }
}
