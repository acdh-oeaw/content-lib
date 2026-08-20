import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { availableParallelism } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { debuglog } from "node:util";

import { addTrailingSlash, log } from "@acdh-oeaw/lib";
import * as watcher from "@parcel/watcher";
import { pascalCase } from "change-case";
import plimit from "p-limit";
import pluralize from "pluralize";

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

function isFileNotFoundError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readFileIfExists(filePath: string): Promise<string | null> {
	return fs.readFile(filePath, { encoding: "utf-8" }).catch((error: unknown) => {
		if (isFileNotFoundError(error)) {
			return null;
		}
		throw error;
	});
}

let temporaryFileCount = 0;

/**
 * Writes `content` to `filePath`, but only when that actually changes the file, so unchanged
 * generated modules keep their modification time and don't needlessly invalidate bundler caches.
 *
 * Content is written to a temporary path and then atomically renamed into place, so consumers never
 * observe a partially written module.
 */
async function writeFileIfChanged(filePath: string, content: string): Promise<boolean> {
	if ((await readFileIfExists(filePath)) === content) {
		debug(`- Skipped unchanged file "${filePath}".`);

		return false;
	}

	const temporaryFilePath = `${filePath}.${String(process.pid)}.${String(temporaryFileCount++)}.tmp`;

	try {
		await fs.writeFile(temporaryFilePath, content, { encoding: "utf-8" });
		await fs.rename(temporaryFilePath, filePath);
	} catch (error) {
		await fs.rm(temporaryFilePath, { force: true });
		throw error;
	}

	debug(`- Wrote file "${filePath}".`);

	return true;
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
	collection: Collection;
	collections: Array<Collection>;
	createImportDeclaration: <T>(path: string) => ImportDeclaration<T>;
	createJavaScriptImport: <T>(content: string) => JavaScriptImport<T>;
	createJsonImport: <T>(content: string) => JsonImport<T>;
}

export interface CollectionConfig<
	TCollectionName extends string = string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	TCollectionItemContent = any,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	TCollectionDocument = any,
> {
	name: TCollectionName;
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

export function createCollection<
	TCollectionName extends string,
	TCollectionItemContent,
	TCollectionDocument,
>(
	config: CollectionConfig<TCollectionName, TCollectionItemContent, TCollectionDocument>,
): CollectionConfig<TCollectionName, TCollectionItemContent, TCollectionDocument> {
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

class ImportDeclaration<T> {
	private __brand!: never;
	value!: T;
	path: string;

	constructor(path: string) {
		this.path = path;
	}
}

function createImportDeclaration<T>(path: string): ImportDeclaration<T> {
	return new ImportDeclaration<T>(path);
}

class JavaScriptImport<T> {
	private __brand!: never;
	value!: T;
	content: string;

	constructor(content: string) {
		this.content = content;
	}
}

function createJavaScriptImport<T>(content: string): JavaScriptImport<T> {
	return new JavaScriptImport<T>(content);
}

class JsonImport<T> {
	private __brand!: never;
	value!: T;
	content: string;

	constructor(content: string) {
		this.content = content;
	}
}

function createJsonImport<T>(content: string): JsonImport<T> {
	return new JsonImport<T>(content);
}

//

export type GetCollection<TConfig extends ContentConfig, TName extends string> = Extract<
	TConfig["collections"][number],
	{ name: TName }
>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type Replace<T> = {
	[K in keyof T]: T[K] extends infer V
		? V extends JavaScriptImport<infer U>
			? U
			: V extends JsonImport<infer U>
				? U
				: V extends ImportDeclaration<infer U>
					? U
					: V extends object
						? Simplify<Replace<V>>
						: V
		: never;
};

export type CollectionEntry<TCollection extends Collection> = Simplify<{
	item: { id: string };
	content: Simplify<Awaited<ReturnType<TCollection["read"]>>>;
	document: Simplify<Replace<Awaited<ReturnType<TCollection["transform"]>>>>;
}>;

//

const prefix = "__i__";
const re = new RegExp(`"(${prefix}\\d+)"`, "g");

/** Files which reference the content-hashed modules of a collection, and must be written last. */
const collectionIndexFileNames = new Set(["index.js", "index.d.ts"]);

function serialize(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	value: Map<string, any>,
	contentProcessorConfigFilePath: string,
	collectionName: string,
): Map<string, string> {
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
				const filePath = `./${hash}.jsx`;

				debug(`Adding javascript import for "${filePath}".`);
				const identifier = addImport(filePath);
				addFiles(filePath, `// @ts-nocheck\n${value.content}`);

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

	result += [`const items = new Map(${json});`, "export default items;"].join("\n\n");

	files.set("index.js", result);

	// eslint-disable-next-line import-x/no-named-as-default-member
	const typeName = pascalCase(pluralize.singular(collectionName));

	files.set(
		"index.d.ts",
		[
			`import type { GetCollection, CollectionEntry } from "@acdh-oeaw/content-lib";`,
			"",
			`import type { config } from "${contentProcessorConfigFilePath}";`,
			"",
			`type Collection = GetCollection<typeof config, "${collectionName}">;`,
			`type ${typeName} = CollectionEntry<Collection>;`,
			"",
			`declare const items: Map<string, ${typeName}>;`,
			`export { type ${typeName}, items as default };`,
		].join("\n"),
	);

	return files;
}

//

interface Collection extends CollectionConfig {
	absoluteDirectoryPath: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	data: Map<CollectionItem["id"], { item: CollectionItem; content: any; document: any }>; // TODO: revisit
	/**
	 * Whether this collection's `transform()` has been observed reading the data of another item,
	 * through `context.collections` or `context.collection.data`.
	 *
	 * Such a transform can go stale when an item it read changes, and nothing records which items
	 * that was, so its results are never reused. Sticky, because a transform may only read other
	 * items for some of its items.
	 */
	hasDataDependencies: boolean;
	outputDirectoryPath: string;
}

/**
 * A filesystem event which is waiting to be processed, together with the collection it belongs to.
 *
 * Events from all collections share one debounce window, so an event cannot be interpreted relative
 * to whichever collection happened to schedule the timer.
 */
interface QueuedEvent {
	collection: Collection;
	/** File path relative to the collection directory. */
	relativeFilePath: string;
	type: watcher.Event["type"];
}

interface BuildStats {
	collections: number;
	documents: number;
}

export interface ContentProcessorConfig {
	/** Path to config file, relative to `process.cwd()`, which provides a named export `config`. */
	configFilePath: string;
}

export interface ContentProcessor {
	build: () => Promise<BuildStats>;
	watch: () => Promise<Set<watcher.AsyncSubscription>>;
	/**
	 * Resolves once the processor has no regeneration pending, i.e. no debounced batch of filesystem
	 * events is waiting to be processed and no regeneration is running or queued.
	 *
	 * Note that this can only account for filesystem events which have already been delivered. It is
	 * not a guarantee that a file written a moment ago has been published, because the watcher may
	 * not have been told about it yet.
	 */
	idle: () => Promise<void>;
	/**
	 * Stops watching and waits for an in-flight regeneration to settle, so that closing cannot leave
	 * a partially written output tree behind.
	 *
	 * Safe to call when `watch()` was never called, and safe to call more than once.
	 */
	close: () => Promise<void>;
}

export async function createContentProcessor(
	contentProcessorConfig: ContentProcessorConfig,
): Promise<ContentProcessor> {
	debug("Creating content processor...\n");

	debug("Reading config file...");
	const contentProcessorConfigUrl = pathToFileURL(
		path.resolve(contentProcessorConfig.configFilePath),
	);
	contentProcessorConfigUrl.searchParams.set("cache-key", String(Date.now()));
	const contentProcessorConfigFilePath = String(contentProcessorConfigUrl);
	const { config } = (await import(contentProcessorConfigFilePath)) as { config: ContentConfig }; // TODO: validate
	debug(`Done reading config file "${contentProcessorConfigFilePath}".`);

	const concurrency = availableParallelism();
	const limit = plimit(concurrency);
	debug(`Concurrency: ${String(concurrency)}.\n`);

	const outputDirectoryBasePath = path.join(process.cwd(), ".content", "generated");

	const collections: Array<Collection> = [];

	const context = {
		collections,
		createImportDeclaration,
		createJavaScriptImport,
		createJsonImport,
	};

	/**
	 * The transform context, with `collections` and `collection.data` wrapped so that reading another
	 * item's data is recorded.
	 *
	 * Reading other items is supported, it just cannot be reconciled with reusing transform results:
	 * nothing tracks *which* items were read, so there is no way to tell when a result went stale.
	 * A collection which does it is therefore always transformed in full.
	 */
	function createTransformContext(collection: Collection): TransformContext {
		function markDataDependency(): void {
			if (collection.hasDataDependencies) {
				return;
			}

			collection.hasDataDependencies = true;

			debug(
				`Collection "${collection.name}" reads other item data during transform, so its results are not reused.`,
			);
		}

		return {
			...context,

			collection: new Proxy(collection, {
				get(target, property, receiver) {
					if (property === "data") {
						markDataDependency();
					}

					// eslint-disable-next-line @typescript-eslint/no-unsafe-return
					return Reflect.get(target, property, receiver);
				},
			}),

			collections: new Proxy(collections, {
				get(target, property, receiver) {
					markDataDependency();

					// eslint-disable-next-line @typescript-eslint/no-unsafe-return
					return Reflect.get(target, property, receiver);
				},
			}),
		};
	}

	for (const collection of config.collections) {
		const absoluteDirectoryPath = addTrailingSlash(path.resolve(collection.directory));

		/** Ensure directory exists, which is expected by `@parcel/watcher`. */
		await fs.mkdir(absoluteDirectoryPath, { recursive: true });

		const outputDirectoryPath = path.join(
			outputDirectoryBasePath,
			collection.name.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-"),
		);

		collections.push({
			...collection,
			absoluteDirectoryPath,
			data: new Map(),
			hasDataDependencies: false,
			outputDirectoryPath,
		});
	}

	async function generate(signal?: AbortSignal): Promise<void> {
		debug("Generating...\n");

		/**
		 * An item is stale when its content or document is `null`. `build()` clears the collection
		 * data, so a build always reads and transforms everything, and the watcher nulls out only the
		 * items whose source file changed, so a regeneration only redoes those.
		 */
		for (const collection of collections) {
			const stale = Array.from(collection.data).filter(([, entry]) => {
				return entry.content == null;
			});

			debug(
				`Reading ${String(stale.length)} of ${String(collection.data.size)} item(s) in collection "${collection.name}"...`,
			);

			await limit.map(stale, async ([id, entry]) => {
				/**
				 * Aborted work is skipped rather than dequeued: `limit.clearQueue()` discards queued jobs
				 * whose promises then never settle, which would hang this `limit.map()` forever, and
				 * would also discard jobs belonging to whichever generation runs next.
				 */
				if (signal?.aborted === true) {
					return;
				}

				// TODO: skip item when `read()` returns `null`?
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				const content = await collection.read(entry.item);

				/**
				 * The item may have changed or been deleted while it was being read. The watcher
				 * replaces the entry, so a stale result must not be written back over the new one, which
				 * would leave it looking up to date while holding content from before the change.
				 */
				if (collection.data.get(id) !== entry) {
					debug(`- Discarded stale read of item "${id}".`);
					return;
				}

				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				entry.content = content;

				debug(`- Read item "${id}".`);
			});

			debug(`Done reading collection "${collection.name}".\n`);
		}

		for (const collection of collections) {
			const transformContext = createTransformContext(collection);

			/**
			 * Previous results of a transform which reads other items are never reused, because nothing
			 * records which items it read, and so nothing can tell when the result went stale.
			 */
			const stale = Array.from(collection.data).filter(([, entry]) => {
				return entry.document == null || collection.hasDataDependencies;
			});

			debug(
				`Transforming ${String(stale.length)} of ${String(collection.data.size)} item(s) in collection "${collection.name}"...`,
			);

			await limit.map(stale, async ([id, entry]) => {
				if (signal?.aborted === true) {
					return;
				}

				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				const document = await collection.transform(entry.content, entry.item, transformContext);

				/** As with reading: the item may have been replaced while it was being transformed. */
				if (collection.data.get(id) !== entry) {
					debug(`- Discarded stale transform of item "${id}".`);
					return;
				}

				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				entry.document = document;

				debug(`- Transformed item "${id}".`);
			});

			debug(`Done transforming collection "${collection.name}".\n`);
		}

		await fs.mkdir(outputDirectoryBasePath, { recursive: true });

		for (const collection of collections) {
			if (signal?.aborted === true) {
				debug("Aborted writing collections.");
				return;
			}

			debug(`Writing collection "${collection.name}".`);

			debug(`Creating output directory for "${collection.name}".`);
			await fs.mkdir(collection.outputDirectoryPath, { recursive: true });

			const files = serialize(
				collection.data,
				path.relative(collection.outputDirectoryPath, contentProcessorConfig.configFilePath),
				collection.name,
			);

			const entries = Array.from(files, ([filePath, fileContent]) => {
				return [path.normalize(filePath), fileContent] as const;
			});

			/**
			 * Content-hashed modules are written before the collection index which references them, so
			 * the index never points to a module which does not exist on disk yet.
			 */
			await limit.map(
				entries.filter(([filePath]) => {
					return !collectionIndexFileNames.has(filePath);
				}),
				async ([filePath, fileContent]) => {
					await writeFileIfChanged(
						path.join(collection.outputDirectoryPath, filePath),
						fileContent,
					);
				},
			);

			await limit.map(
				entries.filter(([filePath]) => {
					return collectionIndexFileNames.has(filePath);
				}),
				async ([filePath, fileContent]) => {
					await writeFileIfChanged(
						path.join(collection.outputDirectoryPath, filePath),
						fileContent,
					);
				},
			);

			/** Obsolete modules are only removed once the new index has stopped referencing them. */
			await removeObsoleteFiles(
				collection.outputDirectoryPath,
				new Set(
					entries.map(([filePath]) => {
						return filePath;
					}),
				),
			);
		}

		await removeObsoleteCollectionDirectories();
	}

	/** Removes everything in `directoryPath` which is not part of the current generation. */
	async function removeObsoleteFiles(directoryPath: string, fileNames: Set<string>): Promise<void> {
		const entries = await fs.readdir(directoryPath, { withFileTypes: true });

		await limit.map(entries, async (entry) => {
			if (fileNames.has(entry.name)) {
				return;
			}

			await fs.rm(path.join(directoryPath, entry.name), { force: true, recursive: true });

			debug(`- Removed obsolete file "${entry.name}".`);
		});
	}

	/** Removes output directories of collections which no longer exist in the config. */
	async function removeObsoleteCollectionDirectories(): Promise<void> {
		const directoryNames = new Set(
			collections.map((collection) => {
				return path.basename(collection.outputDirectoryPath);
			}),
		);

		const entries = await fs.readdir(outputDirectoryBasePath, { withFileTypes: true });

		for (const entry of entries) {
			if (directoryNames.has(entry.name)) {
				continue;
			}

			await fs.rm(path.join(outputDirectoryBasePath, entry.name), { force: true, recursive: true });

			debug(`Removed obsolete output directory "${entry.name}".`);
		}
	}

	async function build(): Promise<BuildStats> {
		debug("Building...\n");

		for (const collection of collections) {
			debug(`Building collection "${collection.name}"...`);

			/**
			 * A build reflects the current state of the filesystem, so items which have since been
			 * deleted must not survive from a previous build.
			 */
			collection.data.clear();

			// eslint-disable-next-line n/no-unsupported-features/node-builtins
			for await (const filePath of fs.glob(collection.include, {
				cwd: collection.directory,
				exclude: collection.exclude,
			})) {
				const absoluteFilePath = path.join(collection.directory, filePath);
				const id = createIdFromFilePath(filePath);

				const stats = await fs.stat(absoluteFilePath).catch((error: unknown) => {
					if (isFileNotFoundError(error)) {
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

	const subscriptions = new Set<watcher.AsyncSubscription>();

	const debounceDelayMs = 150;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let isProcessingEvents = false;
	let isClosed = false;
	let isHandlingTerminationSignals = false;
	/**
	 * All collections share one debounce window, because `generate()` regenerates every collection
	 * anyway, and coalescing avoids regenerating once per collection.
	 *
	 * The batch is keyed by collection *and* path, so two collections which watch overlapping
	 * directories cannot drop each other's events.
	 */
	let batch = new Map<string, QueuedEvent>();

	/**
	 * Regenerations are serialized: a superseded generation is aborted, but the next one only starts
	 * once it has fully settled.
	 *
	 * Running them concurrently is not safe. They share the collection data maps, and they share the
	 * concurrency limiter, so an aborted generation calling `limit.clearQueue()` while unwinding
	 * would discard work belonging to the generation which replaced it.
	 */
	let generation: Promise<void> | null = null;
	let generationController: AbortController | null = null;
	let isGenerationQueued = false;

	let idleResolvers: Array<() => void> = [];

	function isIdle(): boolean {
		return timer == null && !isProcessingEvents && generation == null;
	}

	function notifyIdle(): void {
		if (!isIdle()) {
			return;
		}

		const resolvers = idleResolvers;
		idleResolvers = [];

		for (const resolve of resolvers) {
			resolve();
		}
	}

	function idle(): Promise<void> {
		if (isIdle()) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve) => {
			idleResolvers.push(resolve);
		});
	}

	async function runQueuedGenerations(): Promise<void> {
		try {
			while (isGenerationQueued) {
				isGenerationQueued = false;
				generationController = new AbortController();

				try {
					await generate(generationController.signal);
				} catch (error) {
					/** Keep watching: the next change may well fix whatever failed here. */
					log.error("Failed to generate content.\n", error);
				}
			}
		} finally {
			generationController = null;
			generation = null;
		}

		notifyIdle();
	}

	function scheduleGeneration(): void {
		if (isClosed) {
			return;
		}

		isGenerationQueued = true;

		if (generation != null) {
			debug("Superseding the running generation.");
			generationController?.abort();

			return;
		}

		generation = Promise.resolve().then(runQueuedGenerations);
	}

	function handleTerminationSignal(): void {
		void close();
	}

	async function close(): Promise<void> {
		debug("Cleaning up...");

		isClosed = true;

		process.off("SIGINT", handleTerminationSignal);
		process.off("SIGTERM", handleTerminationSignal);
		isHandlingTerminationSignals = false;

		if (timer != null) {
			clearTimeout(timer);
		}
		timer = null;
		batch = new Map();

		/**
		 * Wait for the running generation to unwind, so closing cannot leave a half-written output
		 * tree behind.
		 */
		isGenerationQueued = false;
		generationController?.abort();
		await generation;

		for (const subscription of subscriptions) {
			await subscription.unsubscribe();
		}
		subscriptions.clear();

		notifyIdle();
	}

	async function watch(): Promise<Set<watcher.AsyncSubscription>> {
		debug("Watching...\n");

		isClosed = false;

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
							batch.set([collection.name, event.path].join(":"), {
								collection,
								relativeFilePath,
								type: event.type,
							});

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
						const events = batch;
						batch = new Map();
						timer = null;
						/** Keeps `idle()` from resolving while the batch is still being applied. */
						isProcessingEvents = true;

						try {
							let isChanged = false;

							for (const event of events.values()) {
								/** Never the collection captured by this callback, which owns the timer, not the event. */
								const eventCollection = event.collection;
								const filePath = event.relativeFilePath;
								const id = createIdFromFilePath(filePath);

								debug(
									`Processing "${event.type}" event for "${id}" in collection "${eventCollection.name}".`,
								);

								switch (event.type) {
									case "create":
									case "update": {
										const absoluteFilePath = path.join(eventCollection.directory, filePath);

										const stats = await fs.stat(absoluteFilePath).catch((error: unknown) => {
											if (isFileNotFoundError(error)) {
												return null;
											}
											throw error;
										});
										if (stats == null) {
											continue;
										}
										const { mtimeMs: timestamp } = stats;

										const item: CollectionItem = { id, filePath, absoluteFilePath, timestamp };

										eventCollection.data.set(id, { item, content: null, document: null });

										/**
										 * Every event which survives the `include` filter belongs to its collection, so
										 * the collection has changed whether the item is new or not.
										 *
										 * The event type cannot be used to tell those apart: creating a file usually
										 * emits both a "create" and an "update" event, and the batch is keyed by path, so
										 * only the "update" event survives debouncing.
										 */
										isChanged = true;

										break;
									}

									case "delete": {
										isChanged ||= eventCollection.data.has(id);

										eventCollection.data.delete(id);

										break;
									}
								}
							}

							if (isChanged) {
								scheduleGeneration();
							}
						} catch (error) {
							/** Keep watching: the next change may well fix whatever failed here. */
							log.error("Failed to process content changes.\n", error);
						} finally {
							isProcessingEvents = false;
							notifyIdle();
						}
					}, debounceDelayMs);
				},
				{ ignore },
			);

			subscriptions.add(subscription);
		}

		/** Registered once, and removed again by `close()`, so repeated watching cannot leak them. */
		if (!isHandlingTerminationSignals) {
			isHandlingTerminationSignals = true;
			process.once("SIGINT", handleTerminationSignal);
			process.once("SIGTERM", handleTerminationSignal);
		}

		return subscriptions;
	}

	return {
		build,
		watch,
		idle,
		close,
	};
}
