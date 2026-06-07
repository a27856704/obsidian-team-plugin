import { requestUrl } from 'obsidian';
import { BaseAIProvider, SummarizeOptions, ReportOptions, DocumentContent } from './AIProvider';
import { ClaudeMessageResponse, readResponseJson } from '../utils/api';

export class ClaudeProvider extends BaseAIProvider {
    name = 'Claude';

    private defaultEndpoint = 'https://api.anthropic.com/v1/messages';

    constructor(apiKey: string, endpoint?: string, model?: string) {
        super(apiKey, endpoint || '', model || 'claude-3-sonnet-20240229');
    }

    private getEndpoint(): string {
        return this.endpoint || this.defaultEndpoint;
    }

    async summarize(content: string, options?: SummarizeOptions): Promise<string> {
        const prompt = this.buildSummarizePrompt(content, options);
        return await this.chatWithProvider(prompt);
    }

    async generateReport(documents: DocumentContent[], options?: ReportOptions): Promise<string> {
        const prompt = this.buildReportPrompt(documents, options);
        return await this.chatWithProvider(prompt);
    }

    async testConnection(): Promise<boolean> {
        try {
            await this.chatWithProvider('Hello, please respond with "OK"');
            return true;
        } catch {
            return false;
        }
    }

    protected async chatWithProvider(prompt: string): Promise<string> {
        const response = await requestUrl({
            url: this.getEndpoint(),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: 4000,
                system: '你是一个专业的文档助手，擅长总结文档内容和生成工作报告。',
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
            }),
        });

        if (response.status !== 200) {
            throw new Error(`Claude API error: ${response.status}`);
        }

        const data = readResponseJson<ClaudeMessageResponse>(response);
        return data.content?.[0]?.text ?? '';
    }
}
