import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		/**
		 * The content processor resolves both the config file and the generated output directory
		 * relative to `process.cwd()`, so tests change the working directory. Every test file needs its
		 * own process for that to be safe.
		 */
		pool: "forks",
		isolate: true,
		/** The watcher tests wait for debounced filesystem events. */
		testTimeout: 30_000,
	},
});
