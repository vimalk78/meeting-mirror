import { describe, it, expect } from "vitest";
import { decideForget, decideShare, relayChangePrompt } from "./index-share.js";

const stored = { relay: "https://r.example", name: "ols-4596", key: "K1" };
const byName = (name: string) => (name === "ols-4596" ? stored : null);

describe("decideShare", () => {
	it("empty args: no stored room, no env → local", () => {
		expect(decideShare("", null, () => null, undefined)).toEqual({ mode: "local" });
	});

	it("empty args: stored room → relay with it", () => {
		expect(decideShare("", stored, byName, undefined)).toEqual({ mode: "relay", room: stored, isNew: false, needsConfirm: false });
	});

	it("empty args: no stored, env set → relay with random name, new, no confirm", () => {
		const d = decideShare("", null, () => null, "https://r.example");
		expect(d.mode).toBe("relay");
		if (d.mode === "relay") {
			expect(d.isNew).toBe(true);
			expect(d.needsConfirm).toBe(false);
			expect(d.room.relay).toBe("https://r.example");
			expect(d.room.name).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
			expect(d.room.key).toMatch(/^[0-9a-f-]{36}$/);
		}
	});

	it("empty args: stored room on the env relay → relay with it", () => {
		expect(decideShare("", stored, byName, "https://r.example/")).toEqual({ mode: "relay", room: stored, isNew: false, needsConfirm: false });
	});

	it("empty args: stored room on a different relay than env → new room on env relay, confirm, names the old room", () => {
		const d = decideShare("", stored, byName, "https://new.example");
		expect(d).toMatchObject({ mode: "relay", isNew: true, needsConfirm: true, replaces: stored });
		if (d.mode === "relay") {
			expect(d.room.relay).toBe("https://new.example");
			expect(d.room.name).not.toBe(stored.name);
			expect(d.room.key).not.toBe(stored.key);
		}
	});

	it("named: stored for that name → relay, not new", () => {
		expect(decideShare("ols-4596", stored, byName, undefined)).toEqual({ mode: "relay", room: stored, isNew: false, needsConfirm: false });
	});

	it("named: not stored, env → new, needs confirm", () => {
		const d = decideShare("ols-4999", null, () => null, "https://r.example");
		expect(d).toMatchObject({ mode: "relay", isNew: true, needsConfirm: true });
	});

	it("named: not stored, no env → error", () => {
		expect(decideShare("ols-4999", null, () => null, undefined)).toEqual({
			mode: "error",
			message: "Room names need relay mode (set MEETING_MIRROR_RELAY).",
		});
	});

	it("link → relay with the link's room", () => {
		const d = decideShare("https://r2.example/s/ols-5000?key=K9", stored, byName, undefined);
		expect(d).toMatchObject({
			mode: "relay",
			room: { relay: "https://r2.example", name: "ols-5000", key: "K9" },
			isNew: true,
		});
	});

	it("link equal to stored room → not new", () => {
		const d = decideShare("https://r.example/s/ols-4596?key=K1", stored, byName, undefined);
		expect(d).toMatchObject({ isNew: false, needsConfirm: false });
	});

	it("invalid args → error naming the forms", () => {
		const d = decideShare("Bad Name!", null, () => null, "https://r.example");
		expect(d.mode).toBe("error");
		if (d.mode === "error") expect(d.message).toMatch(/\/mirror share/);
	});
});

describe("decideForget", () => {
	it("while sharing → refuse, tell to unshare first", () => {
		expect(decideForget(true, stored)).toEqual({
			action: "notify",
			message: "Run /mirror unshare first, then /mirror forget.",
		});
	});

	it("no stored room → nothing to forget", () => {
		expect(decideForget(false, null)).toEqual({
			action: "notify",
			message: "This session has no stored room.",
		});
	});

	it("stored room, not sharing → append the marker, name the room", () => {
		expect(decideForget(false, stored)).toEqual({
			action: "forget",
			message: `Meeting Mirror: forgot room ols-4596 (https://r.example). /mirror share now follows MEETING_MIRROR_RELAY; unset means local mode.`,
		});
	});
});

describe("relayChangePrompt", () => {
	it("names the old room, both relays, and the link change", () => {
		const p = relayChangePrompt(stored, { relay: "https://new.example", name: "abcd1234", key: "K" });
		expect(p).toContain("ols-4596");
		expect(p).toContain("https://r.example");
		expect(p).toContain("https://new.example");
		expect(p).toMatch(/link will change/i);
		expect(p).toMatch(/\/mirror share <link>|\/mirror forget/);
	});
});
