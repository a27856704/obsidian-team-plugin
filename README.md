# Team Collaboration（Obsidian 插件）

本 GitHub 仓库为 **社区安装 / Release 用**：根目录需包含 `manifest.json`、`README.md`、`LICENSE`，并在 **Releases** 中为每个版本上传 `main.js`、`manifest.json`、`styles.css`（及 `versions.json` 若存在）。

**完整源码**（插件 + 服务端）：<https://github.com/a27856704/obsidian-team-plugin-source>

## 自建后端

团队协作功能需 **自建或使用第三方后端**（REST + WebSocket）。在插件设置中填写服务器地址。AI 相关功能需在设置中配置 OpenAI / Claude API 密钥。

## 安装

Obsidian：**设置 → 社区插件 → 浏览**；或手动将 Release 中的文件放入 `.obsidian/plugins/team-collaboration/`。

## License

MIT
