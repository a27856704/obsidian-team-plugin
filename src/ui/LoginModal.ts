import { App, Modal, Setting, Notice, requestUrl } from 'obsidian';
import type TeamPlugin from '../main';

export class LoginModal extends Modal {
    private plugin: TeamPlugin;
    private isRegisterMode = false;

    // Login fields
    private account = '';
    private password = '';
    private captchaInput = '';
    private captchaId = '';

    // Register fields
    private regUsername = '';
    private regEmail = '';
    private regPassword = '';
    private regConfirmPassword = '';
    private regCaptchaInput = '';

    // Captcha
    private captchaSvg = '';

    // Callback to refresh TeamView after login
    private onLoginSuccess?: () => void;

    constructor(app: App, plugin: TeamPlugin, onLoginSuccess?: () => void) {
        super(app);
        this.plugin = plugin;
        this.onLoginSuccess = onLoginSuccess;
    }

    async onOpen() {
        await this.loadCaptcha();
        this.renderLogin();
    }

    private async loadCaptcha() {
        if (!this.plugin.settings.serverUrl) {
            new Notice('请先在设置中配置服务器地址');
            return;
        }

        try {
            const url = `${this.plugin.settings.serverUrl}/api/auth/captcha`;
            const response = await requestUrl({ url, method: 'GET' });
            const data = response.json;
            this.captchaId = data.captchaId;
            this.captchaSvg = data.captchaSvg;
        } catch (e) {
            console.error('Failed to load captcha:', e);
            new Notice('获取验证码失败，请检查服务器地址');
        }
    }

    private renderLogin() {
        this.isRegisterMode = false;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('team-login-modal');

        contentEl.createEl('h2', { text: '登录' });

        new Setting(contentEl)
            .setName('账号')
            .setDesc('用户名或邮箱')
            .addText(text => text
                .setPlaceholder('用户名 / 邮箱')
                .setValue(this.account)
                .onChange(value => { this.account = value; })
            );

        new Setting(contentEl)
            .setName('密码')
            .addText(text => {
                text.setPlaceholder('密码')
                    .setValue(this.password)
                    .onChange(value => { this.password = value; });
                text.inputEl.type = 'password';
            });

        // Captcha
        this.renderCaptchaSection(contentEl, false);

        // Buttons
        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('登录')
                .setCta()
                .onClick(() => this.handleLogin())
            )
            .addButton(button => button
                .setButtonText('去注册')
                .onClick(async () => {
                    await this.loadCaptcha();
                    this.renderRegister();
                })
            );
    }

    private renderRegister() {
        this.isRegisterMode = true;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('team-login-modal');

        contentEl.createEl('h2', { text: '注册' });

        new Setting(contentEl)
            .setName('用户名')
            .addText(text => text
                .setPlaceholder('3-20个字符')
                .setValue(this.regUsername)
                .onChange(value => { this.regUsername = value; })
            );

        new Setting(contentEl)
            .setName('邮箱')
            .addText(text => text
                .setPlaceholder('user@example.com')
                .setValue(this.regEmail)
                .onChange(value => { this.regEmail = value; })
            );

        new Setting(contentEl)
            .setName('密码')
            .addText(text => {
                text.setPlaceholder('至少6个字符')
                    .setValue(this.regPassword)
                    .onChange(value => { this.regPassword = value; });
                text.inputEl.type = 'password';
            });

        new Setting(contentEl)
            .setName('确认密码')
            .addText(text => {
                text.setPlaceholder('再次输入密码')
                    .setValue(this.regConfirmPassword)
                    .onChange(value => { this.regConfirmPassword = value; });
                text.inputEl.type = 'password';
            });

        // Captcha
        this.renderCaptchaSection(contentEl, true);

        // Buttons
        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('注册')
                .setCta()
                .onClick(() => this.handleRegister())
            )
            .addButton(button => button
                .setButtonText('返回登录')
                .onClick(async () => {
                    await this.loadCaptcha();
                    this.renderLogin();
                })
            );
    }

    private renderCaptchaSection(containerEl: HTMLElement, isRegister: boolean) {
        const captchaDiv = containerEl.createDiv('captcha-section');

        captchaDiv.createSpan({ text: '验证码', cls: 'captcha-label' });

        const captchaImg = captchaDiv.createDiv('captcha-image');
        if (this.captchaSvg) {
            captchaImg.innerHTML = this.captchaSvg;
        } else {
            captchaImg.textContent = '点击加载';
            captchaImg.addClass('captcha-image-empty');
        }
        captchaImg.setAttribute('title', '点击刷新验证码');
        captchaImg.addEventListener('click', async () => {
            captchaImg.textContent = '加载中...';
            await this.loadCaptcha();
            if (this.captchaSvg) {
                captchaImg.innerHTML = this.captchaSvg;
            } else {
                captchaImg.textContent = '加载失败，点击重试';
            }
        });

        // Text input
        const input = captchaDiv.createEl('input', {
            cls: 'captcha-input',
            attr: { type: 'text', placeholder: '输入验证码' }
        });

        if (isRegister && this.regCaptchaInput) {
            input.value = this.regCaptchaInput;
        } else if (!isRegister && this.captchaInput) {
            input.value = this.captchaInput;
        }

        input.addEventListener('input', (e: Event) => {
            const value = (e.target as HTMLInputElement).value;
            if (isRegister) {
                this.regCaptchaInput = value;
            } else {
                this.captchaInput = value;
            }
        });
    }

    private async handleLogin() {
        if (!this.account.trim() || !this.password) {
            new Notice('请输入账号和密码');
            return;
        }
        if (!this.captchaInput.trim()) {
            new Notice('请输入验证码');
            return;
        }
        if (!this.captchaId) {
            new Notice('验证码未加载，请点击验证码图片刷新');
            return;
        }

        try {
            const response = await requestUrl({
                url: `${this.plugin.settings.serverUrl}/api/auth/login`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account: this.account.trim(),
                    password: this.password,
                    captchaId: this.captchaId,
                    captchaText: this.captchaInput.trim(),
                }),
            });

            const data = response.json;

            if (!data.success) {
                new Notice(`登录失败: ${data.error || '未知错误'}`);
                this.captchaInput = '';
                await this.loadCaptcha();
                this.renderLogin();
                return;
            }

            // Login success
            this.plugin.settings.apiKey = data.token;
            this.plugin.settings.userId = data.user.id;
            this.plugin.settings.username = data.user.username;
            await this.plugin.saveSettings();

            new Notice(`欢迎回来，${data.user.username}！`);
            this.close();

            // Trigger TeamView refresh
            if (this.onLoginSuccess) {
                this.onLoginSuccess();
            }
        } catch (e: any) {
            console.error('Login error:', e);
            new Notice('登录请求失败，请检查网络和服务器地址');
        }
    }

    private async handleRegister() {
        if (!this.regUsername.trim() || !this.regEmail.trim() || !this.regPassword) {
            new Notice('请填写所有必填字段');
            return;
        }
        if (this.regPassword !== this.regConfirmPassword) {
            new Notice('两次输入的密码不一致');
            return;
        }
        if (this.regPassword.length < 6) {
            new Notice('密码至少6个字符');
            return;
        }
        if (!this.regCaptchaInput.trim()) {
            new Notice('请输入验证码');
            return;
        }
        if (!this.captchaId) {
            new Notice('验证码未加载，请点击验证码图片刷新');
            return;
        }

        try {
            const response = await requestUrl({
                url: `${this.plugin.settings.serverUrl}/api/auth/register`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: this.regUsername.trim(),
                    email: this.regEmail.trim(),
                    password: this.regPassword,
                    captchaId: this.captchaId,
                    captchaText: this.regCaptchaInput.trim(),
                }),
            });

            const data = response.json;

            if (!data.success) {
                // Show error, reload captcha, STAY on register view
                new Notice(`注册失败: ${data.error || '未知错误'}`);
                this.regCaptchaInput = '';
                await this.loadCaptcha();
                this.renderRegister();  // <-- stays on register, not login
                return;
            }

            // Register success
            this.plugin.settings.apiKey = data.token;
            this.plugin.settings.userId = data.user.id;
            this.plugin.settings.username = data.user.username;
            await this.plugin.saveSettings();

            new Notice(`注册成功！欢迎，${data.user.username}！`);
            this.close();

            // Trigger TeamView refresh
            if (this.onLoginSuccess) {
                this.onLoginSuccess();
            }
        } catch (e: any) {
            console.error('Register error:', e);
            new Notice('注册请求失败，请检查网络和服务器地址');
            // Stay on register view on network error too
            this.regCaptchaInput = '';
            await this.loadCaptcha();
            this.renderRegister();
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
