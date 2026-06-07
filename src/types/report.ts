// Report related types
export interface Report {
    id: string;
    type: ReportType;
    title: string;
    content: string;
    summary?: string;
    dateRange: DateRange;
    createdAt: number;
    documents: ReportDocument[];
    stats: ReportStats;
}

export type ReportType = 'daily' | 'weekly' | 'monthly';

export interface DateRange {
    start: number;
    end: number;
}

export interface ReportDocument {
    path: string;
    title: string;
    createdAt?: number;
    modifiedAt: number;
    wordCount: number;
    summary?: string;
}

export interface ReportStats {
    totalDocuments: number;
    newDocuments: number;
    modifiedDocuments: number;
    totalWords: number;
    newWords: number;
}

export interface ReportTemplate {
    id: string;
    name: string;
    type: ReportType;
    template: string;
    isDefault: boolean;
}

export const DEFAULT_DAILY_TEMPLATE = `# 日报 - {{date}}

## 今日概要
{{summary}}

## 今日工作
{{#each documents}}
### {{title}}
- 路径: {{path}}
- 修改时间: {{modifiedAt}}
{{#if summary}}
- 摘要: {{summary}}
{{/if}}
{{/each}}

## 统计数据
- 文档总数: {{stats.totalDocuments}}
- 新建文档: {{stats.newDocuments}}
- 修改文档: {{stats.modifiedDocuments}}
- 总字数: {{stats.totalWords}}
`;

export const DEFAULT_MONTHLY_TEMPLATE = `# 月报 - {{month}}

## 月度摘要
{{summary}}

## 重点工作
{{#each highlights}}
- {{this}}
{{/each}}

## 文档列表
{{#each documents}}
### {{title}}
- 创建时间: {{createdAt}}
- 最后修改: {{modifiedAt}}
- 字数: {{wordCount}}
{{/each}}

## 月度统计
- 文档总数: {{stats.totalDocuments}}
- 新建文档: {{stats.newDocuments}}
- 总字数: {{stats.totalWords}}
- 新增字数: {{stats.newWords}}
`;
