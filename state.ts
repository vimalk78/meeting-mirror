export type MirrorMessage = {
	role: "user" | "assistant";
	text: string;
	timestamp: number;
};

export type Poll = {
	question: string;
	options: { key: string; label: string }[];
};

export type VoteRecord = {
	username: string;
	choice: string;
	remark: string;
};

export type MirrorEvent =
	| { type: "transcript_delta"; message: MirrorMessage }
	| { type: "poll_open"; poll: Poll; anchor: number }
	| { type: "poll_reveal"; votes: VoteRecord[] }
	| { type: "poll_close" }
	| { type: "transcript_reset"; snapshot: MirrorSnapshot };

export type MirrorSnapshot = {
	messages: MirrorMessage[];
	poll: Poll | null;
	revealed: VoteRecord[] | null;
	voteCount: number | null;
	pollAnchor: number | null;
};

type Subscriber = (event: MirrorEvent) => void;

export class MirrorState {
	private messages: MirrorMessage[] = [];
	private poll: Poll | null = null;
	private pollAnchor: number | null = null;
	private revealed: VoteRecord[] | null = null;
	private votes = new Map<string, VoteRecord>();
	private subscribers = new Set<Subscriber>();

	subscribe(fn: Subscriber): () => void {
		this.subscribers.add(fn);
		return () => {
			this.subscribers.delete(fn);
		};
	}

	appendMessage(message: MirrorMessage): void {
		this.messages.push(message);
		this.emit({ type: "transcript_delta", message });
	}

	openPoll(poll: Poll): MirrorEvent[] {
		if (this.poll) {
			throw new Error("A poll is already open. Close it with /poll close first.");
		}
		this.poll = poll;
		this.pollAnchor = this.messages.length;
		this.revealed = null;
		this.votes.clear();
		return this.emit({ type: "poll_open", poll, anchor: this.pollAnchor });
	}

	castVote(username: string, choice: string, remark: string): void {
		if (!this.poll || this.revealed) {
			if (this.revealed) {
				throw new Error("Votes have already been revealed for this poll.");
			}
			throw new Error("No poll is open.");
		}
		if (!this.poll.options.some((o) => o.key === choice)) {
			throw new Error(`Unknown choice key: ${choice}`);
		}
		this.votes.set(username, { username, choice, remark: remark ?? "" });
	}

	reveal(): MirrorEvent[] {
		if (!this.poll || this.revealed) {
			throw new Error("No poll is open.");
		}
		this.revealed = [...this.votes.values()];
		return this.emit({ type: "poll_reveal", votes: this.revealed });
	}

	closePoll(): MirrorEvent[] {
		if (!this.poll) {
			throw new Error("No poll is open.");
		}
		const events = this.emit({ type: "poll_close" });
		this.poll = null;
		this.pollAnchor = null;
		this.revealed = null;
		this.votes.clear();
		return events;
	}

	/** Names that voted in the current poll, in insertion order. */
	voters(): string[] {
		return [...this.votes.keys()];
	}

	getSnapshot(): MirrorSnapshot {
		return {
			messages: [...this.messages],
			poll: this.poll,
			revealed: this.revealed,
			voteCount: this.poll ? this.votes.size : null,
			pollAnchor: this.pollAnchor,
		};
	}

	/**
	 * Replace the whole transcript (used when the session branch is
	 * rewound or forked) without touching poll state.
	 */
	resetMessages(messages: MirrorMessage[]): MirrorEvent[] {
		this.messages = [...messages];
		return this.emit({ type: "transcript_reset", snapshot: this.getSnapshot() });
	}

	private emit(event: MirrorEvent): MirrorEvent[] {
		for (const fn of this.subscribers) fn(event);
		return [event];
	}
}
