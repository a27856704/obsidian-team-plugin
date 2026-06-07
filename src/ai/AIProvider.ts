// AI Provider abstract interface
export interface AIProvider {
    name: string;

    /**
     * Summarize document content
     */
    summarize(content: string, options?: SummarizeOptions): Promise<string>;

    /**
     * Generate report from documents
     */
    generateReport(documents: DocumentContent[], options?: ReportOptions): Promise<string>;

    /**
     * Generate final report from pre-made per-document summaries (reduce step)
     */
    generateReportFromSummaries(summaries: DocumentSummary[], stats: ReportStats, options?: ReportOptions): Promise<string>;

    /**
     * Test API connection
     */
    testConnection(): Promise<boolean>;
}

export interface SummarizeOptions {
    maxLength?: number;
    style?: 'brief' | 'detailed' | 'bullet-points';
    language?: 'zh' | 'en';
}

export interface ReportOptions {
    type: 'daily' | 'weekly' | 'monthly';
    includeStats?: boolean;
    highlightCount?: number;
    language?: 'zh' | 'en';
}

export interface DocumentContent {
    title: string;
    path: string;
    content: string;
    createdAt?: number;
    modifiedAt: number;
}

export interface DocumentSummary {
    title: string;
    path: string;
    summary: string;
    wordCount: number;
    modifiedAt: number;
}

export interface ReportStats {
    totalDocuments: number;
    newDocuments: number;
    modifiedDocuments: number;
    totalWords: number;
    newWords: number;
}

export interface AIResponse {
    success: boolean;
    content?: string;
    error?: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

// Base class for AI providers
export abstract class BaseAIProvider implements AIProvider {
    abstract name: string;
    protected apiKey: string;
    protected endpoint: string;
    protected model: string;

    constructor(apiKey: string, endpoint: string, model: string) {
        this.apiKey = apiKey;
        this.endpoint = endpoint;
        this.model = model;
    }

    abstract summarize(content: string, options?: SummarizeOptions): Promise<string>;
    abstract generateReport(documents: DocumentContent[], options?: ReportOptions): Promise<string>;
    abstract testConnection(): Promise<boolean>;

    /**
     * Reduce step: combine per-document summaries into final report
     */
    async generateReportFromSummaries(summaries: DocumentSummary[], stats: ReportStats, options?: ReportOptions): Promise<string> {
        const prompt = this.buildReducePrompt(summaries, stats, options);
        return await this.chatWithProvider(prompt);
    }

    /**
     * Abstract chat method — each provider implements its own API call
     */
    protected abstract chatWithProvider(prompt: string): Promise<string>;

    protected buildSummarizePrompt(content: string, options?: SummarizeOptions): string {
        const lang = options?.language === 'en' ? 'English' : '中文';
        const style = options?.style || 'brief';

        let styleInstruction = '';
        switch (style) {
            case 'brief':
                styleInstruction = '简洁的一段话总结';
                break;
            case 'detailed':
                styleInstruction = '详细的多段落总结';
                break;
            case 'bullet-points':
                styleInstruction = '使用要点列表的形式';
                break;
        }

        return `请用${lang}对以下内容进行总结，要求：${styleInstruction}。
${options?.maxLength ? `总结不超过${options.maxLength}字。` : ''}

内容：
${content}`;
    }

    protected buildReportPrompt(documents: DocumentContent[], options?: ReportOptions): string {
        const lang = options?.language === 'en' ? 'English' : '中文';
        const typeMap = {
            'daily': '日报',
            'weekly': '周报',
            'monthly': '月报'
        };
        const reportType = typeMap[options?.type || 'daily'];

        const docSummaries = documents.map(doc =>
            `文档：${doc.title}\n路径：${doc.path}\n内容摘要：${doc.content.substring(0, 500)}...`
        ).join('\n\n---\n\n');

        return `请根据以下文档内容，生成一份${reportType}。使用${lang}输出。

要求：
1. 总结主要工作内容和成果
2. 提取${options?.highlightCount || 3}个重点工作亮点
3. ${options?.includeStats ? '包含工作量统计' : ''}
4. 语言要专业、简洁

文档内容：
${docSummaries}`;
    }

    /**
     * Build the Reduce prompt: combine per-doc summaries + stats → final report
     */
    protected buildReducePrompt(summaries: DocumentSummary[], stats: ReportStats, options?: ReportOptions): string {
        const lang = options?.language === 'en' ? 'English' : '中文';
        const typeMap = {
            'daily': '日报',
            'weekly': '周报',
            'monthly': '月报'
        };
        const reportType = typeMap[options?.type || 'daily'];

        const docList = summaries.map(s =>
            `### ${s.title}\n- 字数：${s.wordCount}\n- 摘要：${s.summary}`
        ).join('\n\n');

        return `请根据以下各文档的内容摘要和统计数据，生成一份完整的${reportType}。使用${lang}输出。

## 统计概览
- 文档总数：${stats.totalDocuments}
- 新建文档：${stats.newDocuments}
- 修改文档：${stats.modifiedDocuments}
- 总字数：${stats.totalWords}
- 新增字数：${stats.newWords}

## 各文档摘要

${docList}

## 要求
1. 总结主要工作内容和成果
2. 提取 ${options?.highlightCount || 3} 个重点工作亮点
3. 包含工作量统计分析
4. 语言要专业、简洁
5. 按 Markdown 格式输出`;
    }
}
