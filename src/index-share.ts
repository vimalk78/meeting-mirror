/** Pure share-decision logic, separated from index.ts for testing. */
import type { Room } from "./rooms.js";
import { isRoomName, parseRoomLink, parseShareArgs, randomRoomName, ShareArgError } from "./rooms.js";

export type ShareDecision =
	| { mode: "local" }
	| { mode: "relay"; room: Room; isNew: boolean; needsConfirm: boolean }
	| { mode: "error"; message: string };

export function randomKey(): string {
	return crypto.randomUUID();
}

/**
 * Decide what /mirror share does.
 * - a full link, or a room stored in this session → relay mode
 * - otherwise MEETING_MIRROR_RELAY decides: set → relay, unset → local
 */
export function decideShare(
	args: string,
	stored: Room | null,
	storedByName: (name: string) => Room | null,
	envRelay: string | undefined,
): ShareDecision {
	const relayUrl = envRelay?.replace(/\/+$/, "");
	const envRelayClean = !relayUrl ? undefined : relayUrl;
	let parsed;
	try {
		parsed = parseShareArgs(args);
	} catch (err) {
		if (err instanceof ShareArgError) return { mode: "error", message: err.message };
		throw err;
	}

	if (parsed.kind === "link") {
		const isNew = !stored || stored.name !== parsed.room.name || stored.key !== parsed.room.key;
		return { mode: "relay", room: parsed.room, isNew, needsConfirm: false };
	}

	if (parsed.kind === "name") {
		const existing = storedByName(parsed.name);
		if (existing) return { mode: "relay", room: existing, isNew: false, needsConfirm: false };
		if (!envRelayClean) {
			return { mode: "error", message: "Room names need relay mode (set MEETING_MIRROR_RELAY)." };
		}
		return {
			mode: "relay",
			room: { relay: envRelayClean, name: parsed.name, key: randomKey() },
			isNew: true,
			needsConfirm: true,
		};
	}

	// default: stored room, else env relay, else local
	if (stored) return { mode: "relay", room: stored, isNew: false, needsConfirm: false };
	if (envRelayClean) {
		return {
			mode: "relay",
			room: { relay: envRelayClean, name: randomRoomName(), key: randomKey() },
			isNew: true,
			needsConfirm: false,
		};
	}
	return { mode: "local" };
}
