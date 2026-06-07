import { App, Modal, Setting, Notice } from 'obsidian';
import type TeamPlugin from '../main';
import { TeamRole } from '../types/team';

export class InviteMemberModal extends Modal {
    private plugin: TeamPlugin;
    private teamId: string;
    private email = '';
    private role: TeamRole = 'member';

    constructor(app: App, plugin: TeamPlugin, teamId: string) {
        super(app);
        this.plugin = plugin;
        this.teamId = teamId;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('team-invite-modal');

        contentEl.createEl('h2', { text: '邀请成员' });

        new Setting(contentEl)
            .setName('邮箱地址')
            .setDesc('输入要邀请成员的邮箱')
            .addText(text => text
                .setPlaceholder('user@example.com')
                .onChange(value => {
                    this.email = value;
                })
            );

        new Setting(contentEl)
            .setName('角色')
            .setDesc('设置成员在团队中的角色')
            .addDropdown(dropdown => dropdown
                .addOption('member', '成员')
                .addOption('admin', '管理员')
                .addOption('viewer', '访客')
                .setValue(this.role)
                .onChange(value => {
                    this.role = value as TeamRole;
                })
            );

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('发送邀请')
                .setCta()
                .onClick(async () => {
                    await this.handleInvite();
                })
            )
            .addButton(button => button
                .setButtonText('取消')
                .onClick(() => {
                    this.close();
                })
            );
    }

    private async handleInvite() {
        if (!this.email.trim()) {
            new Notice('请输入邮箱地址');
            return;
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(this.email.trim())) {
            new Notice('请输入有效的邮箱地址');
            return;
        }

        try {
            await this.plugin.teamManager.inviteMember(
                this.teamId,
                this.email.trim(),
                this.role
            );

            new Notice(`邀请已发送至 ${this.email}`);
            this.close();
        } catch (error) {
            console.error('Invite error:', error);
            new Notice(`邀请失败: ${error}`);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
