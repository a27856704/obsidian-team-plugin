import { App, Modal, Setting, Notice } from 'obsidian';
import * as Y from 'yjs';
import { TeamPluginSettings } from '../types';
import TeamPlugin from '../main';

export class HistoryModal extends Modal {
    plugin: TeamPlugin;
    teamId: string;
    docId: string;
    docPath: string;
    histories: any[] = [];

    constructor(app: App, plugin: TeamPlugin, teamId: string, docId: string, docPath: string) {
        super(app);
        this.plugin = plugin;
        this.teamId = teamId;
        this.docId = docId;
        this.docPath = docPath;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: `📜 文档时光机: ${this.docPath}` });
        const loadingEl = contentEl.createEl('div', { text: '正在加载历史版本清单...' });

        try {
            this.histories = await this.plugin.teamManager.getTeamDocumentHistories(this.teamId, this.docId);
            loadingEl.remove();

            if (this.histories.length === 0) {
                contentEl.createEl('div', { text: '暂无记录。历史快照将在大家持续协同编辑时由服务器自动定期生成。' });
                return;
            }

            const listEl = contentEl.createEl('div', { cls: 'history-list' });
            listEl.style.maxHeight = '400px';
            listEl.style.overflowY = 'auto';

            this.histories.forEach(h => {
                const row = listEl.createEl('div', { cls: 'history-item' });
                row.style.borderBottom = '1px solid var(--background-modifier-border)';
                row.style.padding = '10px';
                row.style.display = 'flex';
                row.style.justifyContent = 'space-between';
                row.style.alignItems = 'center';

                const info = row.createEl('div');
                info.createEl('div', { text: `版本 ${h.version} — 由 ${h.savedByName} 保存` });
                const dateText = new Date(h.createdAt).toLocaleString();
                info.createEl('small', { text: dateText, cls: 'text-muted' });

                const btnGroup = row.createEl('div');

                const restoreBtn = btnGroup.createEl('button', { text: '🔄 还原到此' });
                restoreBtn.onclick = () => this.restoreHistory(h.id);
            });
        } catch (e: any) {
            loadingEl.innerText = `加载失败: ${e.message}`;
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    async restoreHistory(historyId: string) {
        // Warning
        if (!confirm('确定要用该版本覆盖当前的云端文档吗？此操作不可逆！(正在协同的人将自动同步到此版本)')) {
            return;
        }

        try {
            const snapshot = await this.plugin.teamManager.getTeamDocumentHistorySnapshot(this.teamId, this.docId, historyId);
            if (!snapshot.ydoc) throw new Error("返回快照数据为空");

            // Convert base64 to Uint8Array
            const binaryString = atob(snapshot.ydoc);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // Load into a temporary YDoc to extract text
            const tempDoc = new Y.Doc();
            Y.applyUpdate(tempDoc, bytes);
            const restoredText = tempDoc.getText('codemirror').toString();

            // 若当前文件刚好正被打开编辑，最丝滑的做法就是直接调用底层替换：
            // 因为没暴露 WebSocket，目前我们选择最强力的操作：
            // 通过 API 强行作为新提交压入后端
            await this.plugin.teamManager.createTeamDocument(this.teamId, this.docPath, restoredText);

            new Notice(`✅ 已成功恢复到版本 v${snapshot.version}`);
            this.close();
        } catch (e: any) {
            new Notice(`还原失败: ${e.message}`);
        }
    }
}
