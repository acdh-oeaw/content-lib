import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { debuglog } from "node:util";

import { addTrailingSlash, log } from "@acdh-oeaw/lib";
import * as watcher from "@parcel/watcher";

//

const debug = debuglog("content-lib");

//

function createContentHash(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function createIdFromFilePath(filePath: string): string {
	const parsed = path.parse(filePath);

	if (parsed.name.toLowerCase() === "index") {
		return path.basename(parsed.dir);
	}

	return parsed.name;
}

//

type MaybePromise<T> = T | Promise<T>;

type NonEmptyReadonlyArray<T> = readonly [T, ...Array<T>];

type GlobString = string;

interface CollectionItem {
	/** Unique identifier. */
	id: string;
	/** File path relative to colleciton directory. */
	filePath: string;
	/** File path relative to current working directory. */
	absoluteFilePath: string;
	/** File modification timestamp. */
	timestamp: number;
}

interface TransformContext {
	createImportDeclaration: (path: string) => ImportDeclaration;
	createJavaScriptImport: (content: string) => JavaScriptImport;
	createJsonImport: (content: string) => JsonImport;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CollectionConfig<TCollectionItemContent = any, TCollectionDocument = any> {
	name: string;
	directory: string;
	include: NonEmptyReadonlyArray<GlobString>;
	exclude?: ReadonlyArray<GlobString>;
	read: (item: CollectionItem) => MaybePromise<TCollectionItemContent>;
	transform: (
		content: TCollectionItemContent,
		item: CollectionItem,
		context: TransformContext,
	) => MaybePromise<TCollectionDocument>;
}

export function createCollection<TCollectionItemContent, TCollectionDocument>(
	config: CollectionConfig<TCollectionItemContent, TCollectionDocument>,
): CollectionConfig<TCollectionItemContent, TCollectionDocument> {
	return config;
}

export interface ContentConfig {
	collections: Array<CollectionConfig>;
}

export function createConfig<T extends ContentConfig>(config: T): T {
	return config;
}

//

// function createItemCacheKey(item: CollectionItem): string {
// 	return String(item.timestamp);
// }

//

class ImportDeclaration {
	path: string;

	constructor(path: string) {
		this.path = path;
	}
}

function createImportDeclaration(path: string): ImportDeclaration {
	return new ImportDeclaration(path);
}

class JavaScriptImport {
	content: string;

	constructor(content: string) {
		this.content = content;
	}
}

function createJavaScriptImport(content: string): JavaScriptImport {
	return new JavaScriptImport(content);
}

class JsonImport {
	content: string;

	constructor(content: string) {
		this.content = content;
	}
}

function createJsonImport(content: string): JsonImport {
	return new JsonImport(content);
}

//

const prefix = "__i__";
const re = new RegExp(`"(${prefix}\\d+)"`, "g");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialize(value: Map<string, any>): [string, Map<string, string>] {
	debug("Serializing...\n");

	const imports: Array<string> = [];

	function addImport(filePath: string, type: "js" | "json" = "js"): string {
		const identifier = [prefix, imports.length].join("");
		imports.push(
			`import ${identifier} from "${filePath}"${type !== "js" ? ` with { type: "${type}" }` : ""};`,
		);

		return identifier;
	}

	const files = new Map<string, string>();

	function addFiles(filePath: string, content: string): void {
		files.set(filePath, content);
	}

	const json = JSON.stringify(
		Array.from(value),
		// TODO: Should we support (multiple) named imports?
		(_key, value) => {
			if (value instanceof ImportDeclaration) {
				const filePath = value.path;

				debug(`Adding import declaration for "${filePath}".`);
				const identifier = addImport(filePath);

				return identifier;
			}

			if (value instanceof JavaScriptImport) {
				const hash = createContentHash(value.content);
				const filePath = `./${hash}.js`;

				debug(`Adding javascript import for "${filePath}".`);
				const identifier = addImport(filePath);
				addFiles(filePath, value.content);

				return identifier;
			}

			if (value instanceof JsonImport) {
				const hash = createContentHash(value.content);
				const filePath = `./${hash}.json`;

				debug(`Adding json import for "${filePath}".`);
				const identifier = addImport(filePath, "json");
				addFiles(filePath, value.content);

				return identifier;
			}

			// eslint-disable-next-line @typescript-eslint/no-unsafe-return
			return value;
		},
		2,
	)
		/** Remove quotes from import identifiers. */
		.replaceAll(re, "$1");

	let result = "";

	if (imports.length > 0) {
		result += imports.join("\n");
		result += "\n\n";
	}

	result += `const items = new Map(${json});\n\nexport default items;`;

	return [result, files];
}

//

interface Collection extends CollectionConfig {
	absoluteDirectoryPath: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	data: Map<CollectionItem["id"], { item: CollectionItem; content: any; document: any }>; // TODO: revisit
	outputDirectoryPath: string;
}

interface BuildStats {
	collections: number;
	documents: number;
}

export interface ContentProcessor {
	build: () => Promise<BuildStats>;
	watch: () => Promise<Set<watcher.AsyncSubscription>>;
}

export async function createContentProcessor(config: ContentConfig): Promise<ContentProcessor> {
	debug("Creating content processor...\n");

	const outputDirectoryBasePath = path.join(process.cwd(), ".content", "generated");

	debug("Clearing output directory...\n");
	await fs.rm(outputDirectoryBasePath, { force: true, recursive: true });

	const collections: Array<Collection> = [];

	const context: TransformContext = {
		createImportDeclaration,
		createJavaScriptImport,
		createJsonImport,
	};

	for (const collection of config.collections) {
		const absoluteDirectoryPath = addTrailingSlash(path.resolve(collection.directory));

		const outputDirectoryPath = path.join(outputDirectoryBasePath, collection.name);
		await fs.mkdir(outputDirectoryPath, { recursive: true });

		collections.push({
			...collection,
			absoluteDirectoryPath,
			data: new Map(),
			outputDirectoryPath,
		});
	}

	async function generate(signal?: AbortSignal): Promise<void> {
		debug("Generating...\n");

		for (const collection of collections) {
			debug(`Reading collection "${collection.name}"...`);

			for (const [id, { item }] of collection.data) {
				if (signal?.aborted === true) {
					debug("Aborted reading collections.");
					return;
				}

				// FIXME: race condition: what if file has been deleted in the meantime
				// TODO: skip item when `read()` returns `null`?
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				const content = await collection.read(item);
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				collection.data.get(id)!.content = content;

				debug(`- Read item "${id}".`);
			}

			debug(
				`Done reading ${String(collection.data.size)} item(s) in collection "${collection.name}".\n`,
			);
		}

		for (const collection of collections) {
			debug(`Transforming collection "${collection.name}"...`);

			for (const [id, { content, item }] of collection.data) {
				if (signal?.aborted === true) {
					debug("Aborted transforming collections.");
					return;
				}

				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				const document = await collection.transform(content, item, context);
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				collection.data.get(id)!.document = document;

				debug(`- Transformed item "${id}".`);
			}

			debug(
				`Done transforming ${String(collection.data.size)} item(s) in collection "${collection.name}".\n`,
			);
		}

		if (signal?.aborted === true) {
			debug("Aborted writing collections.");
			return;
		}

		for (const collection of collections) {
			debug(`Writing collection "${collection.name}".`);

			// TODO: Consider combining serializing and writing to disk in one function.
			const outputFilePath = path.join(collection.outputDirectoryPath, "index.js");
			const [serialized, files] = serialize(collection.data);
			await fs.writeFile(outputFilePath, serialized, { encoding: "utf-8" });
			for (const [filePath, fileContent] of files) {
				const outputFilePath = path.join(collection.outputDirectoryPath, filePath);
				await fs.writeFile(outputFilePath, fileContent, { encoding: "utf-8" });
			}
		}
	}

	async function build(): Promise<BuildStats> {
		debug("Building...\n");

		for (const collection of collections) {
			debug(`Building collection "${collection.name}"...`);

			// eslint-disable-next-line n/no-unsupported-features/node-builtins
			for await (const filePath of fs.glob(collection.include, {
				cwd: collection.directory,
				exclude: collection.exclude,
			})) {
				const absoluteFilePath = path.join(collection.directory, filePath);
				const id = createIdFromFilePath(filePath);

				const stats = await fs.stat(absoluteFilePath).catch((error: unknown) => {
					if (error instanceof Error && "code" in error && error.code === "ENOENT") {
						return null;
					}
					throw error;
				});
				if (stats == null) {
					continue;
				}
				const { mtimeMs: timestamp } = stats;

				const item: CollectionItem = { id, filePath, absoluteFilePath, timestamp };

				collection.data.set(id, { item, content: null, document: null });

				debug(`- Added item "${id}" (path: "${filePath}").`);
			}

			debug(
				`Done adding ${String(collection.data.size)} item(s) to collection "${collection.name}".\n`,
			);
		}

		await generate();

		return {
			collections: collections.length,
			documents: collections.reduce((acc, collection) => {
				return acc + collection.data.size;
			}, 0),
		};
	}

	async function watch(): Promise<Set<watcher.AsyncSubscription>> {
		debug("Watching...\n");

		const subscriptions = new Set<watcher.AsyncSubscription>();

		const debounceDelayMs = 150;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let controller: AbortController | null = null;
		let batch = new Map<watcher.Event["path"], watcher.Event & { relativeFilePath: string }>();

		for (const collection of collections) {
			debug(`Watching collection "${collection.name}"...`);

			/**
			 * Ideally, we could just add `include` as a negative ignore pattern.
			 *
			 * This is currently not supported by `@parcel/watcher`. Simple patterns like "!*.md" do seem
			 * to work, but others like "!*\/index.md" do not.
			 *
			 * Therefore we need to filter out matching events in the javascript main thread
			 * (see `path.matchesGlob` below).
			 *
			 * @see https://github.com/parcel-bundler/watcher/issues/166
			 */
			// const ignore = [
			// 	...collection.include.map((glob) => {
			// 		return `!${glob}`;
			// 	}),
			// 	...(collection.exclude ?? []),
			// ];
			const ignore = (collection.exclude ?? []) as Array<string>;

			const subscription = await watcher.subscribe(
				collection.directory,
				(error, events) => {
					if (error != null) {
						log.error(error);
						return;
					}

					debug(`- ${String(events.length)} events in collection "${collection.name}".`);

					for (const event of events) {
						// const relativeFilePath = path.relative(collection.directory, event.path);
						const relativeFilePath = event.path.slice(collection.absoluteDirectoryPath.length);

						if (
							collection.include.some((pattern) => {
								// eslint-disable-next-line n/no-unsupported-features/node-builtins
								return path.matchesGlob(relativeFilePath, pattern);
							})
						) {
							(event as watcher.Event & { relativeFilePath: string }).relativeFilePath =
								relativeFilePath;
							batch.set(event.path, event as watcher.Event & { relativeFilePath: string });

							debug(`- Added "${event.type}" event for "${relativeFilePath}" to queue.`);
						} else {
							debug(`- Discarded "${event.type}" event for "${relativeFilePath}".`);
						}
					}

					if (timer != null) {
						clearTimeout(timer);
					}

					// eslint-disable-next-line @typescript-eslint/no-misused-promises
					timer = setTimeout(async () => {
						if (controller != null) {
							controller.abort();
						}

						controller = new AbortController();

						const events = batch;
						batch = new Map();
						timer = null;

						let isCollectionChanged = false;

						for (const event of events.values()) {
							const filePath = event.relativeFilePath;
							const id = createIdFromFilePath(filePath);

							debug(`Processing "${event.type}" event for "${id}".`);

							switch (event.type) {
								case "create":
								case "update": {
									isCollectionChanged ||= event.type === "create" || collection.data.has(id);

									const absoluteFilePath = path.join(collection.directory, filePath);

									const stats = await fs.stat(absoluteFilePath).catch((error: unknown) => {
										if (error instanceof Error && "code" in error && error.code === "ENOENT") {
											return null;
										}
										throw error;
									});
									if (stats == null) {
										continue;
									}
									const { mtimeMs: timestamp } = stats;

									const item: CollectionItem = { id, filePath, absoluteFilePath, timestamp };

									collection.data.set(id, { item, content: null, document: null });

									break;
								}

								case "delete": {
									isCollectionChanged ||= collection.data.has(id);

									collection.data.delete(id);

									break;
								}
							}
						}

						if (isCollectionChanged) {
							await generate(controller.signal);
						}
					}, debounceDelayMs);
				},
				{ ignore },
			);

			subscriptions.add(subscription);
		}

		async function unsubscribe() {
			debug("Cleaning up...");

			if (timer != null) {
				clearTimeout(timer);
			}
			timer = null;

			if (controller != null) {
				controller.abort();
			}
			controller = null;

			for (const subscription of subscriptions) {
				await subscription.unsubscribe();
			}
			subscriptions.clear();
		}

		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		process.once("SIGINT", unsubscribe);
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		process.once("SIGTERM", unsubscribe);

		return subscriptions;
	}

	return {
		build,
		watch,
	};
}
