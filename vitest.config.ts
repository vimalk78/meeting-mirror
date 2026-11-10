import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["*.test.ts", "relay/src/**/*.test.ts"],
	},
});
