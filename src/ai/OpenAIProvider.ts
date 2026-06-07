import { requestUrl } from 'obsidian';
import { BaseAIProvider, SummarizeOptions, ReportOptions, DocumentContent } from './AIProvider';

export class OpenAIProvider extends BaseAIProvider {
    name = 'OpenAI';

    private defaultEndpoint = 'https://api.openai.com/v1/chat/completions';

    constructor(apiKey: string, endpoint?: string, model?: string) {
        super(apiKey, endpoint || '', model || 'gpt-4');
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
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    {
                        role: 'system',
                        content: '你是一个专业的文档助手，擅长总结文档内容和生成工作报告。'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 4000,
            }),
        });

        if (response.status !== 200) {
            throw new Error(`OpenAI API error: ${response.status}`);
        }

        const data = response.json;
        return data.choices[0]?.message?.content || '';
    }
}
