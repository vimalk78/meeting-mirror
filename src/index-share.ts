/** Pure share-decision logic, separated from index.ts for testing. */
import type { Room } from "./rooms.js";
import { isRoomName, parseRoomLink, parseShareArgs, randomRoomName, ShareArgError } from "./rooms.js";

export type ShareDecision =
	| { mode: "local" }
	| {
			mode: "relay";
			room: Room;
			isNew: boolean;
			needsConfirm: boolean;
			/** Set when the new room replaces a stored room on a different relay. */
			replaces?: Room;
	  }
	| { mode: "error"; message: string };

export function randomKey(): string {
	return crypto.randomUUID();
}

/**
 * Decide what /mirror share does.
 * - a full link, or a room stored in this session → relay mode
 * - but if MEETING_MIRROR_RELAY names a different relay than the stored room,
 *   offer a new room on the env relay (the stored room's relay is stale)
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
	if (stored && envRelayClean && stored.relay.replace(/\/+$/, "") !== envRelayClean) {
		return {
			mode: "relay",
			room: { relay: envRelayClean, name: randomRoomName(), key: randomKey() },
			isNew: true,
			needsConfirm: true,
			replaces: stored,
		};
	}
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

export type ForgetDecision = { action: "notify"; message: string } | { action: "forget"; message: string };

/** Decide what /mirror forget does. "forget" means: append the cleared marker. */
export function decideForget(sharing: boolean, stored: Room | null): ForgetDecision {
	if (sharing) return { action: "notify", message: "Run /mirror unshare first, then /mirror forget." };
	if (!stored) return { action: "notify", message: "This session has no stored room." };
	return {
		action: "forget",
		message: `Meeting Mirror: forgot room ${stored.name} (${stored.relay}). /mirror share now follows MEETING_MIRROR_RELAY; unset means local mode.`,
	};
}

/** Confirmation prompt when MEETING_MIRROR_RELAY differs from the stored room's relay. */
export function relayChangePrompt(stored: Room, next: Room): string {
	return `This session's room "${stored.name}" is on relay
  ${stored.relay}
but MEETING_MIRROR_RELAY is
  ${next.relay}

Start a new room "${next.name}" on ${next.relay}?
The participant link will change. Send the new link to the meeting.

To keep the old room instead, answer No, then set MEETING_MIRROR_RELAY back
to ${stored.relay} (or unset it) and run /mirror share again.
To stop using rooms in this session, answer No and run /mirror forget.`;
}
