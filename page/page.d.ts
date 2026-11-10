export declare function escapeHtml(s: string): string;
export declare function renderMarkdown(md: string): string;
export declare function renderTally(votes: { username: string; choice: string; remark: string }[], options: { key: string; label: string }[]): string;
export declare function formatMessage(m: { role: string; text: string; timestamp: number }): string;
export declare function membersText(list: { members: { name: string; voted: boolean }[]; voteCount: number | null }): string;
export declare function allVotedNotice(
	snapshot: { poll: unknown; revealed: unknown; voteCount: number | null },
	list: { members: unknown[]; voteCount: number | null },
): string | null;
