import { describe, it, expect } from "vitest";
import {
	isRoomName,
	randomRoomName,
	roomLink,
	parseRoomLink,
	parseShareArgs,
	findStoredRoom,
} from "./rooms.js";

describe("isRoomName", () => {
	it("accepts lowercase letters, digits, dashes, 3–30 chars", () => {
		expect(isRoomName("ols-4596")).toBe(true);
		expect(isRoomName("abc")).toBe(true);
		expect(isRoomName("a".repeat(30))).toBe(true);
		expect(isRoomName("a".repeat(31))).toBe(false);
		expect(isRoomName("OLS-4596")).toBe(false);
		expect(isRoomName("ab")).toBe(false);
		expect(isRoomName("ols_4596")).toBe(false);
		expect(isRoomName("")).toBe(false);
	});
});

describe("randomRoomName", () => {
	it("is 8 chars from the lowercase Crockford alphabet and passes isRoomName", () => {
		for (let i = 0; i < 20; i++) {
			const name = randomRoomName();
			expect(name).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
			expect(isRoomName(name)).toBe(true);
		}
	});
});

describe("roomLink / parseRoomLink", () => {
	it("round-trips a room", () => {
		const room = { relay: "https://mirror.example.com", name: "ols-4596", key: "abc-123" };
		const link = roomLink(room);
		expect(link).toBe("https://mirror.example.com/s/ols-4596?key=abc-123");
		expect(parseRoomLink(link)).toEqual(room);
	});

	it("rejects missing key, bad name, non-http scheme", () => {
		expect(() => parseRoomLink("https://mirror.example.com/s/ols-4596")).toThrow();
		expect(() => parseRoomLink("https://mirror.example.com/s/BAD_NAME?key=k")).toThrow();
		expect(() => parseRoomLink("ftp://mirror.example.com/s/ols-4596?key=k")).toThrow();
		expect(() => parseRoomLink("https://mirror.example.com/ols-4596?key=k")).toThrow();
	});
});

describe("parseShareArgs", () => {
	it("empty → default; name → name; link → link; invalid throws", () => {
		expect(parseShareArgs("")).toEqual({ kind: "default" });
		expect(parseShareArgs("   ")).toEqual({ kind: "default" });
		expect(parseShareArgs("ols-4596")).toEqual({ kind: "name", name: "ols-4596" });
		const link = "https://mirror.example.com/s/ols-4596?key=k";
		expect(parseShareArgs(link)).toEqual({
			kind: "link",
			room: { relay: "https://mirror.example.com", name: "ols-4596", key: "k" },
		});
		expect(() => parseShareArgs("Bad Name")).toThrow(/\/mirror share/);
	});
});

describe("findStoredRoom", () => {
	const branch = [
		{ type: "message" },
		{ type: "custom", customType: "other", data: { name: "x", key: "y", relay: "z" } },
		{ type: "custom", customType: "meeting-mirror-room", data: { name: "ols-1", key: "k1", relay: "https://r1" } },
		{ type: "custom", customType: "meeting-mirror-room", data: { name: "ols-2", key: "k2", relay: "https://r2" } },
		{ type: "custom", customType: "meeting-mirror-room", data: { name: "broken" } },
	];

	it("returns the latest valid entry; filters by name; ignores others", () => {
		expect(findStoredRoom(branch as never)).toEqual({ name: "ols-2", key: "k2", relay: "https://r2" });
		expect(findStoredRoom(branch as never, "ols-1")).toEqual({ name: "ols-1", key: "k1", relay: "https://r1" });
		expect(findStoredRoom(branch as never, "ols-9")).toBeNull();
		expect(findStoredRoom([] as never)).toBeNull();
	});

	it("a cleared marker forgets every earlier room", () => {
		const cleared = [...branch, { type: "custom", customType: "meeting-mirror-room", data: { cleared: true } }];
		expect(findStoredRoom(cleared as never)).toBeNull();
		expect(findStoredRoom(cleared as never, "ols-1")).toBeNull();
	});

	it("a room stored after a cleared marker is found again", () => {
		const later = [
			...branch,
			{ type: "custom", customType: "meeting-mirror-room", data: { cleared: true } },
			{ type: "custom", customType: "meeting-mirror-room", data: { name: "ols-3", key: "k3", relay: "https://r3" } },
		];
		expect(findStoredRoom(later as never)).toEqual({ name: "ols-3", key: "k3", relay: "https://r3" });
		expect(findStoredRoom(later as never, "ols-2")).toBeNull();
	});
});
