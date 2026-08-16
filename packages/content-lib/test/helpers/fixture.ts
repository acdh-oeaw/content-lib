import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { onTestFinished } from "vitest";

import { type ContentProcessor, createContentProcessor } from "../../src/index.ts";

const collectionFixtureFilePath = fileURLToPath(
	new URL("../fixtures/collection.js", import.meta.url),
);

const configFileName = "content.config.js";

export const defaultCollectionNames = ["people", "posts"];

export const defaultFiles: Record<string, string> = {
	"content/people/jane-doe.md": "Jane Doe",
	"content/posts/first-post.md": "The first post.",
	"content/posts/second-post.md": "The second post.",
};

export interface FixtureOptions {
	collectionNames?: Array<string>;
	files?: Record<string, string>;
	/** Artificial delay in `read()`, to widen the window for an item changing again while read. */
	readDelayMs?: number;
	/** Collections whose `transform()` reads `context.collections`. */
	readsOtherCollections?: Array<string>;
	/** Artificial delay in `transform()`, to widen the window for superseding a generation. */
	transformDelayMs?: number;
}

export interface Fixture {
	/** Absolute path to the fixture directory, which is also the current working directory. */
	directory: string;
	/** Absolute path to the generated output root. */
	outputDirectory: string;
	/** Creates a content processor for the current config file. */
	createProcessor: () => Promise<ContentProcessor>;
	/**
	 * Registers a cleanup which runs before the fixture directory is removed. Watchers must be
	 * unsubscribed while the directory they watch still exists, otherwise the native watcher backend
	 * leaks into the next test in the same process.
	 */
	onCleanup: (cleanup: () => Promise<void> | void) => void;
	/** Rewrites the config file, e.g. to remove a collection. */
	writeConfig: (collectionNames: Array<string>, transformDelayMs?: number) => Promise<void>;
	/** `read()` and `transform()` calls recorded so far, as `"read posts first-post"`, sorted. */
	readCalls: () => Promise<Array<string>>;
	/** Forgets recorded calls, so the next assertion only sees what happened after this point. */
	clearCalls: () => Promise<void>;
	/** Writes a source file, relative to the fixture directory. */
	writeFile: (filePath: string, content: string) => Promise<void>;
	/** Creates a symlink, relative to the fixture directory. */
	writeSymlink: (filePath: string, target: string) => Promise<void>;
	/** Removes a source file, relative to the fixture directory. */
	removeFile: (filePath: string) => Promise<void>;
	/** Reads a generated file, relative to the generated output root. */
	readGenerated: (filePath: string) => Promise<string>;
	/** Lists generated files, relative to the generated output root, sorted. */
	listGenerated: () => Promise<Array<string>>;
	/**
	 * Identity (inode) and modification time of every generated entry, including directories and the
	 * output root itself, keyed by path relative to the output root.
	 */
	statGenerated: () => Promise<Map<string, string>>;
	/** Content of a collection index, or `null` when it has not been published yet. */
	readIndex: (collectionName: string) => Promise<string | null>;
	/** Module specifiers imported by a collection index, relative to the collection directory. */
	readIndexImports: (collectionName: string) => Promise<Array<string>>;
}

const importSpecifiers = /^import\s+\S+\s+from\s+"([^"]+)"/gm;

export function parseIndexImports(content: string): Array<string> {
	return Array.from(content.matchAll(importSpecifiers), (match) => {
		return match[1]!;
	});
}

function createConfigSource(
	collectionNames: Array<string>,
	transformDelayMs: number,
	readsOtherCollections: Array<string>,
	readDelayMs: number,
): string {
	return [
		`import { createTestCollection } from "./collection.js";`,
		"",
		`const readsOtherCollections = ${JSON.stringify(readsOtherCollections)};`,
		"",
		`const collections = ${JSON.stringify(collectionNames)}.map((name) => {`,
		`\treturn createTestCollection(name, {`,
		`\t\treadDelayMs: ${JSON.stringify(readDelayMs)},`,
		`\t\treadsOtherCollections: readsOtherCollections.includes(name),`,
		`\t\ttransformDelayMs: ${JSON.stringify(transformDelayMs)},`,
		`\t});`,
		`});`,
		"",
		`export const config = { collections };`,
		"",
	].join("\n");
}

/** Ignores entries which disappear mid-walk: the output tree may be regenerating while we look. */
function ignoreMissing<T>(promise: Promise<T>): Promise<T | null> {
	return promise.catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	});
}

async function walk(directoryPath: string, relativePath: string, entries: Map<string, string>) {
	const dirents = await ignoreMissing(
		fs.readdir(path.join(directoryPath, relativePath), { withFileTypes: true }),
	);

	for (const dirent of dirents ?? []) {
		const entryPath = path.join(relativePath, dirent.name);
		const stats = await ignoreMissing(
			fs.stat(path.join(directoryPath, entryPath), { bigint: true }),
		);

		if (stats == null) {
			continue;
		}

		entries.set(
			entryPath,
			[dirent.isDirectory() ? "dir" : "file", stats.ino, stats.mtimeNs].join(":"),
		);

		if (dirent.isDirectory()) {
			await walk(directoryPath, entryPath, entries);
		}
	}
}

export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const collectionNames = options.collectionNames ?? defaultCollectionNames;
	const files = options.files ?? defaultFiles;
	const readDelayMs = options.readDelayMs ?? 0;
	const readsOtherCollections = options.readsOtherCollections ?? [];
	const transformDelayMs = options.transformDelayMs ?? 0;

	/** `fs.realpath` because `@parcel/watcher` reports realpaths, and macOS symlinks its temp dir. */
	const directory = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "content-lib-test-")),
	);
	const outputDirectory = path.join(directory, ".content", "generated");

	const previousWorkingDirectory = process.cwd();
	process.chdir(directory);

	const cleanups: Array<() => Promise<void> | void> = [];

	onTestFinished(async () => {
		for (const cleanup of cleanups.reverse()) {
			await cleanup();
		}

		process.chdir(previousWorkingDirectory);
		/** Retries because a generation which was still in flight may write while we remove. */
		await fs.rm(directory, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 });
	});

	await fs.copyFile(collectionFixtureFilePath, path.join(directory, "collection.js"));

	const fixture: Fixture = {
		directory,
		outputDirectory,

		createProcessor() {
			return createContentProcessor({ configFilePath: configFileName });
		},

		onCleanup(cleanup) {
			cleanups.push(cleanup);
		},

		async readCalls() {
			const content = await fs
				.readFile(path.join(directory, "calls.log"), { encoding: "utf-8" })
				.catch(() => {
					return "";
				});

			return content
				.split("\n")
				.filter((line) => {
					return line.length > 0;
				})
				.sort();
		},

		async clearCalls() {
			await fs.rm(path.join(directory, "calls.log"), { force: true });
		},

		async writeConfig(names, delayMs = transformDelayMs) {
			await fs.writeFile(
				path.join(directory, configFileName),
				createConfigSource(names, delayMs, readsOtherCollections, readDelayMs),
				{
					encoding: "utf-8",
				},
			);
		},

		async writeFile(filePath, content) {
			const absoluteFilePath = path.join(directory, filePath);
			await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
			await fs.writeFile(absoluteFilePath, content, { encoding: "utf-8" });
		},

		async writeSymlink(filePath, target) {
			const absoluteFilePath = path.join(directory, filePath);
			await fs.mkdir(path.dirname(absoluteFilePath), { recursive: true });
			await fs.symlink(target, absoluteFilePath);
		},

		async removeFile(filePath) {
			await fs.rm(path.join(directory, filePath), { force: true });
		},

		readGenerated(filePath) {
			return fs.readFile(path.join(outputDirectory, filePath), { encoding: "utf-8" });
		},

		async listGenerated() {
			const entries = new Map<string, string>();
			await walk(outputDirectory, ".", entries);

			return Array.from(entries)
				.filter(([, value]) => {
					return value.startsWith("file:");
				})
				.map(([key]) => {
					return key;
				})
				.sort();
		},

		async statGenerated() {
			const entries = new Map<string, string>();
			const stats = await fs.stat(outputDirectory, { bigint: true });
			entries.set(".", ["dir", stats.ino, stats.mtimeNs].join(":"));
			await walk(outputDirectory, ".", entries);

			return entries;
		},

		readIndex(collectionName) {
			return fs
				.readFile(path.join(outputDirectory, collectionName, "index.js"), { encoding: "utf-8" })
				.catch(() => {
					return null;
				});
		},

		async readIndexImports(collectionName) {
			const content = await fixture.readGenerated(path.join(collectionName, "index.js"));

			return parseIndexImports(content);
		},
	};

	await fixture.writeConfig(collectionNames);

	for (const [filePath, content] of Object.entries(files)) {
		await fixture.writeFile(filePath, content);
	}

	return fixture;
}
