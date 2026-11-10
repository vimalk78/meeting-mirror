import { randomUUID } from "node:crypto";
import type { MirrorState, MirrorEvent, MirrorSnapshot } from "./state.js";

export type Member = { name: string; voted: boolean };

export type MemberList = {
	members: Member[];
	voteCount: number | null;
};

export type SnapshotEvent = {
	type: "snapshot";
	sessionId: string;
	you: string | null;
	snapshot: MirrorSnapshot;
	members: MemberList;
};

export type HubEvent =
	| Exclude<MirrorEvent, { type: "vote_cast" }>
	| ({ type: "members" } & MemberList);

export type Reply = { status: number; body: unknown };

/**
 * Transport-agnostic room logic: names, presence, votes and the member
 * list. Transports (LocalServer HTTP, RelayClient) call open/close per
 * browser connection and identify/vote for POSTs; the state itself stays
 * in MirrorState.
 */
export class Hub {
	/** Per-run id: changes when the moderator's pi restarts. */
	readonly sessionId = randomUUID();

	/** clientId → name, in join order. */
	private bound = new Map<string, string>();
	/** connId → clientId. */
	private connections = new Map<string, string>();

	constructor(private state: MirrorState) {
		state.subscribe((event) => {
			if (event.type === "transcript_delta" || event.type === "transcript_reset") {
				this.emit(event);
				return;
			}
			// poll events change the member list (ticks reset)
			this.emit(event);
			this.emitMembers();
		});
	}

	subscribe(fn: (event: HubEvent) => void): () => void {
		this.subscribers.add(fn);
		return () => {
			this.subscribers.delete(fn);
		};
	}

	/** A browser connection opened; returns its conn id and first snapshot. */
	open(clientId: string): { connId: string; snapshot: SnapshotEvent } {
		if (this.connections.size >= 2000) {
			throw new Error("too many connections");
		}
		const connId = randomUUID();
		this.connections.set(connId, clientId);
		const hadPresence = this.present(clientId);
		const snapshot: SnapshotEvent = {
			type: "snapshot",
			sessionId: this.sessionId,
			you: this.bound.get(clientId) ?? null,
			snapshot: this.state.getSnapshot(),
			members: this.memberList(),
		};
		if (!hadPresence && this.bound.has(clientId)) this.emitMembers();
		return { connId, snapshot };
	}

	/** A browser connection closed. */
	close(connId: string): void {
		const clientId = this.connections.get(connId);
		this.connections.delete(connId);
		if (clientId && this.bound.has(clientId) && !this.present(clientId)) {
			this.emitMembers();
		}
	}

	/** POST /identify body handling. */
	identify(body: unknown): Reply {
		const { clientId, username } = (body ?? {}) as { clientId?: unknown; username?: unknown };
		if (typeof clientId !== "string" || clientId === "" || typeof username !== "string" || username.trim() === "") {
			return { status: 400, body: { error: "clientId and username required" } };
		}
		if (this.bound.size >= 500) {
			return { status: 503, body: { error: "too many members" } };
		}
		const name = username.trim().slice(0, 40);
		for (const [id, bound] of this.bound) {
			if (bound === name && id !== clientId) {
				if (this.present(id)) {
					return {
						status: 409,
						body: { error: `${name} is already in the room. Choose another name, for example ${name} K.` },
					};
				}
				// the previous owner left: taking the name over drops their binding,
				// so a returning browser must re-identify instead of doubling the name
				this.bound.delete(id);
			}
		}
		const renamed = this.bound.get(clientId) !== name;
		this.bound.set(clientId, name);
		if (renamed) this.emitMembers();
		return { status: 200, body: { name } };
	}

	/** POST /vote body handling. */
	vote(body: unknown): Reply {
		const { clientId, choice, remark } = (body ?? {}) as {
			clientId?: unknown;
			choice?: unknown;
			remark?: unknown;
		};
		if (typeof clientId !== "string" || clientId === "") {
			return { status: 400, body: { error: "clientId required" } };
		}
		const name = this.bound.get(clientId);
		if (!name) {
			return { status: 401, body: { error: "join first" } };
		}
		if (typeof choice !== "string") {
			return { status: 400, body: { error: "choice required" } };
		}
		try {
			this.state.castVote(name, choice, typeof remark === "string" ? remark.slice(0, 500) : "");
		} catch (err) {
			return { status: 409, body: { error: err instanceof Error ? err.message : "vote rejected" } };
		}
		// A vote changes the member list (tick appears / vote count).
		this.emitMembers();
		return { status: 200, body: { ok: true } };
	}

	memberList(): MemberList {
		const voted = new Set(this.state.getSnapshot().revealed === null ? this.state.voters() : []);
		const members: Member[] = [];
		for (const [clientId, name] of this.bound) {
			if (this.present(clientId)) {
				const hasVoted =
					this.state.getSnapshot().poll !== null &&
					this.state.getSnapshot().revealed === null &&
					voted.has(name);
				members.push({ name, voted: hasVoted });
			}
		}
		const voteCount = this.state.getSnapshot().voteCount;
		return { members, voteCount };
	}

	private subscribers = new Set<(event: HubEvent) => void>();

	private present(clientId: string): boolean {
		for (const bound of this.connections.values()) {
			if (bound === clientId) return true;
		}
		return false;
	}

	private emitMembers(): void {
		this.emit({ type: "members", ...this.memberList() });
	}

	private emit(event: HubEvent): void {
		for (const fn of this.subscribers) fn(event);
	}
}
