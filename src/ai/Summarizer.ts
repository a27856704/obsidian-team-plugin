import { App, TFile } from 'obsidian';
import { AIProvider, DocumentContent, DocumentSummary, ReportStats, SummarizeOptions, ReportOptions } from './AIProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { ClaudeProvider } from './ClaudeProvider';
import { TeamPluginSettings } from '../types';

/** Progress callback: (current, total, currentDocTitle) */
export type ProgressCallback = (current: number, total: number, docTitle?: string) => void;

/** Max characters per chunk for long documents */
const CHUNK_SIZE = 6000;

export class Summarizer {
    private app: App;
    private provider: AIProvider | null = null;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Initialize AI provider based on settings
     */
    initProvider(settings: TeamPluginSettings): void {
        const { aiProvider, aiApiKey, aiEndpoint, aiModel } = settings;

        if (!aiApiKey) {
            this.provider = null;
            return;
        }

        switch (aiProvider) {
            case 'openai':
                this.provider = new OpenAIProvider(aiApiKey, aiEndpoint, aiModel);
                break;
            case 'claude':
                this.provider = new ClaudeProvider(aiApiKey, aiEndpoint, aiModel);
                break;
            case 'dmxapi':
                // DMXAPI: OpenAI-compatible proxy, one key for all models
                this.provider = new OpenAIProvider(
                    aiApiKey,
                    aiEndpoint || 'https://www.dmxapi.cn/v1/chat/completions',
                    aiModel || 'gpt-4'
                );
                break;
            case 'custom':
                // Custom provider uses OpenAI-compatible API
                this.provider = new OpenAIProvider(aiApiKey, aiEndpoint, aiModel);
                break;
            default:
                this.provider = null;
        }
    }

    /**
     * Check if AI provider is configured
     */
    isConfigured(): boolean {
        return this.provider !== null;
    }

    /**
     * Test AI connection
     */
    async testConnection(): Promise<boolean> {
        if (!this.provider) return false;
        return await this.provider.testConnection();
    }

    /**
     * Summarize a single file
     */
    async summarizeFile(file: TFile, options?: SummarizeOptions): Promise<string> {
        if (!this.provider) {
            throw new Error('AI provider not configured');
        }

        const content = await this.app.vault.cachedRead(file);
        return await this.provider.summarize(content, options);
    }

    /**
     * Summarize text content
     */
    async summarizeContent(content: string, options?: SummarizeOptions): Promise<string> {
        if (!this.provider) {
            throw new Error('AI provider not configured');
        }

        return await this.provider.summarize(content, options);
    }

    /**
     * Map-Reduce report generation:
     * 1. Map: Summarize each file individually (full text, chunked if long)
     * 2. Reduce: Combine all summaries + stats → final report
     */
    async mapReduceReport(
        files: TFile[],
        stats: ReportStats,
        options?: ReportOptions,
        onProgress?: ProgressCallback
    ): Promise<string> {
        if (!this.provider) {
            throw new Error('AI provider not configured');
        }

        const total = files.length;
        const summaries: DocumentSummary[] = [];

        // === MAP PHASE: summarize each document ===
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            onProgress?.(i + 1, total, file.basename);

            const content = await this.app.vault.cachedRead(file);
            const wordCount = this.countWords(content);

            let summary: string;
            try {
                summary = await this.summarizeFullDocument(content, file.basename);
            } catch (e) {
                console.error(`Failed to summarize ${file.basename}:`, e);
                // Fallback: use first 200 chars as summary
                summary = content.substring(0, 200) + '...';
            }

            summaries.push({
                title: file.basename,
                path: file.path,
                summary,
                wordCount,
                modifiedAt: file.stat.mtime,
            });
        }

        // === REDUCE PHASE: combine summaries into final report ===
        onProgress?.(total, total, '正在生成报告...');

        return await this.provider.generateReportFromSummaries(summaries, stats, options);
    }

    /**
     * Summarize a full document, chunking if needed.
     * For docs <= CHUNK_SIZE chars → single summarize call.
     * For longer docs → split into chunks, summarize each, then merge.
     */
    private async summarizeFullDocument(content: string, title: string): Promise<string> {
        if (!this.provider) throw new Error('AI provider not configured');

        // Strip frontmatter
        const cleanContent = content.replace(/^---[\s\S]*?---\n?/, '').trim();

        if (!cleanContent) {
            return '(空文档)';
        }

        // Short document: summarize directly
        if (cleanContent.length <= CHUNK_SIZE) {
            return await this.provider.summarize(cleanContent, {
                style: 'bullet-points',
                language: 'zh',
                maxLength: 300,
            });
        }

        // Long document: chunk → summarize each → merge
        const chunks = this.splitIntoChunks(cleanContent, CHUNK_SIZE);
        const chunkSummaries: string[] = [];

        for (const chunk of chunks) {
            const chunkSummary = await this.provider.summarize(chunk, {
                style: 'brief',
                language: 'zh',
                maxLength: 200,
            });
            chunkSummaries.push(chunkSummary);
        }

        // Merge chunk summaries into one
        const mergedContent = `文档「${title}」的各段摘要：\n${chunkSummaries.map((s, i) => `第${i + 1}部分：${s}`).join('\n')}`;
        return await this.provider.summarize(mergedContent, {
            style: 'bullet-points',
            language: 'zh',
            maxLength: 300,
        });
    }

    /**
     * Split text into chunks, respecting paragraph boundaries
     */
    private splitIntoChunks(text: string, maxSize: number): string[] {
        const chunks: string[] = [];
        const paragraphs = text.split(/\n\n+/);
        let current = '';

        for (const para of paragraphs) {
            if (current.length + para.length + 2 > maxSize && current.length > 0) {
                chunks.push(current.trim());
                current = '';
            }
            current += para + '\n\n';
        }
        if (current.trim()) {
            chunks.push(current.trim());
        }

        // If any chunk is still too long (single huge paragraph), force-split
        const result: string[] = [];
        for (const chunk of chunks) {
            if (chunk.length > maxSize) {
                for (let i = 0; i < chunk.length; i += maxSize) {
                    result.push(chunk.substring(i, i + maxSize));
                }
            } else {
                result.push(chunk);
            }
        }

        return result;
    }

    /**
     * Count words (Chinese characters + English words)
     */
    private countWords(content: string): number {
        const chineseChars = (content.match(/[\u4e00-\u9fa5]/g) || []).length;
        const englishWords = (content.match(/[a-zA-Z]+/g) || []).length;
        return chineseChars + englishWords;
    }

    // ======= Legacy methods (kept for backward compat) =======

    /**
     * Generate report from files (old method, still uses truncated content)
     * @deprecated Use mapReduceReport instead
     */
    async generateReportFromFiles(files: TFile[], options?: ReportOptions): Promise<string> {
        if (!this.provider) {
            throw new Error('AI provider not configured');
        }

        const documents: DocumentContent[] = await Promise.all(
            files.map(async (file) => ({
                title: file.basename,
                path: file.path,
                content: await this.app.vault.cachedRead(file),
                createdAt: file.stat.ctime,
                modifiedAt: file.stat.mtime,
            }))
        );

        return await this.provider.generateReport(documents, options);
    }

    /**
     * Get word count for a file
     */
    async getWordCount(file: TFile): Promise<number> {
        const content = await this.app.vault.cachedRead(file);
        return this.countWords(content);
    }
}
