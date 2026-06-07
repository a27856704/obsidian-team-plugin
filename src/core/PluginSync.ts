import { App, requestUrl, normalizePath } from 'obsidian';
import { PluginInfo, PluginSyncPackage } from '../types/document';
import { TeamPluginSettings } from '../types';
import * as fs from 'fs';
import * as path from 'path';

export class PluginSync {
    private app: App;
    private settings: TeamPluginSettings;

    constructor(app: App, settings: TeamPluginSettings) {
        this.app = app;
        this.settings = settings;
    }

    updateSettings(settings: TeamPluginSettings): void {
        this.settings = settings;
    }

    private getApiUrl(apiPath: string): string {
        return `${this.settings.serverUrl}${apiPath}`;
    }

    private async request<T>(apiPath: string, method: string, body?: unknown): Promise<T> {
        const response = await requestUrl({
            url: this.getApiUrl(apiPath),
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.settings.apiKey}`,
                'X-User-Id': this.settings.userId,
            },
            body: body ? JSON.stringify(body) : undefined,
        });

        if (response.status >= 400) {
            throw new Error(`API error: ${response.status}`);
        }

        return response.json as T;
    }

    /**
     * Get plugins directory path
     */
    private getPluginsDir(): string {
        const adapter = this.app.vault.adapter;
        // @ts-ignore - accessing internal property
        const basePath = adapter.basePath || '';
        return path.join(basePath, '.obsidian', 'plugins');
    }

    /**
     * Get list of installed plugins
     */
    async getInstalledPlugins(): Promise<PluginInfo[]> {
        const plugins: PluginInfo[] = [];
        const pluginsDir = this.getPluginsDir();

        try {
            const dirs = fs.readdirSync(pluginsDir);

            for (const dir of dirs) {
                const manifestPath = path.join(pluginsDir, dir, 'manifest.json');

                if (fs.existsSync(manifestPath)) {
                    try {
                        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
                        const manifest = JSON.parse(manifestContent);

                        // Check if plugin is enabled
                        // @ts-ignore - accessing internal API
                        const enabledPlugins = this.app.plugins?.enabledPlugins || new Set();

                        // Check if plugin has settings
                        const dataPath = path.join(pluginsDir, dir, 'data.json');
                        const hasSettings = fs.existsSync(dataPath);

                        // Exclude this plugin and system plugins
                        if (manifest.id !== 'team-collaboration' &&
                            !this.settings.excludedPlugins.includes(manifest.id)) {
                            plugins.push({
                                id: manifest.id,
                                name: manifest.name,
                                version: manifest.version,
                                enabled: enabledPlugins.has(manifest.id),
                                hasSettings,
                            });
                        }
                    } catch (e) {
                        console.error(`Error reading manifest for ${dir}:`, e);
                    }
                }
            }
        } catch (e) {
            console.error('Error reading plugins directory:', e);
        }

        return plugins;
    }

    /**
     * Create a sync package with plugin list and optional settings
     */
    async createSyncPackage(): Promise<PluginSyncPackage> {
        const plugins = await this.getInstalledPlugins();
        const settings: Record<string, unknown> = {};

        if (this.settings.syncPluginSettings) {
            const pluginsDir = this.getPluginsDir();

            for (const plugin of plugins) {
                if (plugin.hasSettings) {
                    const dataPath = path.join(pluginsDir, plugin.id, 'data.json');
                    try {
                        const dataContent = fs.readFileSync(dataPath, 'utf-8');
                        settings[plugin.id] = JSON.parse(dataContent);
                    } catch (e) {
                        console.error(`Error reading settings for ${plugin.id}:`, e);
                    }
                }
            }
        }

        return {
            plugins,
            settings,
            timestamp: Date.now(),
        };
    }

    /**
     * Share plugin configuration with team
     */
    async sharePluginConfig(teamId: string): Promise<void> {
        const syncPackage = await this.createSyncPackage();

        await this.request('/api/plugins/share', 'POST', {
            teamId,
            ...syncPackage,
        });
    }

    /**
     * Get shared plugin configuration from team
     */
    async getTeamPluginConfig(teamId: string): Promise<PluginSyncPackage> {
        return await this.request<PluginSyncPackage>(`/api/teams/${teamId}/plugins`, 'GET');
    }

    /**
     * Install plugins from sync package
     * Note: This will only install from community plugins, not arbitrary sources
     */
    async installPluginsFromPackage(syncPackage: PluginSyncPackage): Promise<{
        installed: string[];
        failed: string[];
        skipped: string[];
    }> {
        const installed: string[] = [];
        const failed: string[] = [];
        const skipped: string[] = [];

        const currentPlugins = await this.getInstalledPlugins();
        const currentPluginIds = new Set(currentPlugins.map(p => p.id));

        for (const plugin of syncPackage.plugins) {
            if (currentPluginIds.has(plugin.id)) {
                skipped.push(plugin.id);
                continue;
            }

            try {
                // Try to install from community plugins
                // @ts-ignore - accessing internal API
                const communityPlugins = this.app.plugins;

                if (communityPlugins?.installPlugin) {
                    await communityPlugins.installPlugin(plugin.id);
                    installed.push(plugin.id);

                    // Apply settings if available
                    if (syncPackage.settings[plugin.id] && this.settings.syncPluginSettings) {
                        await this.applyPluginSettings(plugin.id, syncPackage.settings[plugin.id]);
                    }
                }
            } catch (e) {
                console.error(`Failed to install plugin ${plugin.id}:`, e);
                failed.push(plugin.id);
            }
        }

        return { installed, failed, skipped };
    }

    /**
     * Apply settings to a plugin
     */
    private async applyPluginSettings(pluginId: string, settings: unknown): Promise<void> {
        const pluginsDir = this.getPluginsDir();
        const dataPath = path.join(pluginsDir, pluginId, 'data.json');

        try {
            fs.writeFileSync(dataPath, JSON.stringify(settings, null, 2));
        } catch (e) {
            console.error(`Error applying settings for ${pluginId}:`, e);
        }
    }

    /**
     * Generate plugin list markdown
     */
    generatePluginListMarkdown(plugins: PluginInfo[]): string {
        let md = '# 插件列表\n\n';
        md += `共 ${plugins.length} 个插件\n\n`;
        md += '| 插件名称 | ID | 版本 | 状态 |\n';
        md += '|---------|-----|------|------|\n';

        for (const plugin of plugins) {
            const status = plugin.enabled ? '✅ 启用' : '❌ 禁用';
            md += `| ${plugin.name} | ${plugin.id} | ${plugin.version} | ${status} |\n`;
        }

        return md;
    }
}
