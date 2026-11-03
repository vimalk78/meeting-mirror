export declare function escapeHtml(s: string): string;
export declare function renderMarkdown(md: string): string;
export declare function renderTally(votes: { username: string; choice: string; remark: string }[], options: { key: string; label: string }[]): string;
export declare function formatMessage(m: { role: string; text: string; timestamp: number }): string;
