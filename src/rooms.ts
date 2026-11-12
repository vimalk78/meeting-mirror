/** Room name, link and stored-room helpers (pure, transport-agnostic). */

export const STORED_ROOM_TYPE = "meeting-mirror-room";

export type Room = {
	/** Relay origin, e.g. "https://mirror.example.com" */
	relay: string;
	name: string;
	key: string;
};

export class ShareArgError extends Error {}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

export function isRoomName(s: string): boolean {
	return /^[a-z0-9-]{3,30}$/.test(s);
}

export function randomRoomName(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	let out = "";
	for (const b of bytes) out += CROCKFORD[b % CROCKFORD.length];
	return out;
}

export function roomLink(room: Room): string {
	return `${room.relay}/s/${room.name}?key=${encodeURIComponent(room.key)}`;
}

export function parseRoomLink(url: string): Room {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new ShareArgError("Not a valid link.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new ShareArgError("The link must start with http:// or https://.");
	}
	const match = parsed.pathname.match(/^\/s\/([a-z0-9-]{3,30})\/?$/);
	if (!match) {
		throw new ShareArgError("The link must point at /s/<room-name>.");
	}
	const key = parsed.searchParams.get("key");
	if (!key) {
		throw new ShareArgError("The link is missing its key.");
	}
	return { relay: parsed.origin, name: match[1]!, key };
}

export function parseShareArgs(
	args: string,
): { kind: "default" } | { kind: "name"; name: string } | { kind: "link"; room: Room } {
	const trimmed = args.trim();
	if (trimmed === "") return { kind: "default" };
	const stripped = trimmed.replace(/\/+$/, "");
	if (stripped.includes("://")) return { kind: "link", room: parseRoomLink(stripped) };
	if (isRoomName(stripped)) return { kind: "name", name: stripped };
	throw new ShareArgError(
		`Invalid /mirror share argument. Use "/mirror share", "/mirror share <room-name>", or "/mirror share <full link>".`,
	);
}

/** Data for the marker entry that /mirror forget appends. */
export const CLEARED_ROOM_MARKER = { cleared: true } as const;

export function findStoredRoom(
	branch: { type?: string; customType?: string; data?: unknown }[],
	name?: string,
): Room | null {
	let found: Room | null = null;
	let foundForName: Room | null = null;
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== STORED_ROOM_TYPE) continue;
		const data = entry.data as { name?: unknown; key?: unknown; relay?: unknown; cleared?: unknown } | undefined;
		if (data?.cleared === true) {
			// /mirror forget: earlier rooms no longer count.
			found = null;
			foundForName = null;
			continue;
		}
		if (
			data &&
			typeof data.name === "string" &&
			typeof data.key === "string" &&
			typeof data.relay === "string" &&
			isRoomName(data.name)
		) {
			const room: Room = { name: data.name, key: data.key, relay: data.relay };
			found = room;
			if (name && room.name === name) foundForName = room;
		}
	}
	if (name) return foundForName;
	return found;
}
