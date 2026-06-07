import { App, Modal, Setting, Notice } from 'obsidian';
import type TeamPlugin from '../main';

export class CreateTeamModal extends Modal {
    private plugin: TeamPlugin;
    private teamName = '';
    private teamDescription = '';

    constructor(app: App, plugin: TeamPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('team-create-modal');

        contentEl.createEl('h2', { text: '创建团队' });

        new Setting(contentEl)
            .setName('团队名称')
            .setDesc('为你的团队取一个名字')
            .addText(text => text
                .setPlaceholder('例如：产品研发组')
                .onChange(value => {
                    this.teamName = value;
                })
            );

        new Setting(contentEl)
            .setName('团队描述')
            .setDesc('简要描述团队的用途')
            .addTextArea(text => text
                .setPlaceholder('团队的简要描述...')
                .onChange(value => {
                    this.teamDescription = value;
                })
            );

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('创建')
                .setCta()
                .onClick(() => {
                    void this.handleCreate();
                })
            )
            .addButton(button => button
                .setButtonText('取消')
                .onClick(() => {
                    this.close();
                })
            );
    }

    private async handleCreate() {
        if (!this.teamName.trim()) {
            new Notice('请输入团队名称');
            return;
        }

        try {
            const team = await this.plugin.teamManager.createTeam(
                this.teamName.trim(),
                this.teamDescription.trim()
            );

            this.plugin.settings.currentTeamId = team.id;
            await this.plugin.saveSettings();

            new Notice(`团队 "${team.name}" 创建成功！`);
            this.close();

            // Refresh team view
            void this.plugin.activateTeamView();
        } catch (error) {
            console.error('Create team error:', error);
            new Notice(`创建失败: ${error}`);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
