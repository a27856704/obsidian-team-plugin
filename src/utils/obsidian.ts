import { MarkdownView, type App, type DataAdapter, type Editor, type TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';

interface VaultAdapterWithBasePath extends DataAdapter {
    basePath?: string;
}

interface EditorWithCodeMirror extends Editor {
    cm?: EditorView;
}

interface PluginsHost {
    enabledPlugins?: Set<string>;
    installPlugin?: (id: string) => Promise<void>;
}

export function getVaultBasePath(adapter: DataAdapter): string {
    return (adapter as VaultAdapterWithBasePath).basePath ?? '';
}

export function getEnabledPluginIds(app: App): Set<string> {
    const plugins = (app as App & { plugins?: PluginsHost }).plugins;
    return plugins?.enabledPlugins ?? new Set<string>();
}

export function getPluginInstaller(app: App): PluginsHost | undefined {
    return (app as App & { plugins?: PluginsHost }).plugins;
}

export function getMarkdownEditorView(file: TFile, app: App): EditorView | null {
    const leaves = app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === file.path) {
            const editor = view.editor as EditorWithCodeMirror;
            return editor.cm ?? null;
        }
    }
    return null;
}
