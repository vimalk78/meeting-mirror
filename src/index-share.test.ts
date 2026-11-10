import { describe, it, expect } from "vitest";
import { decideShare } from "./index-share.js";

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
