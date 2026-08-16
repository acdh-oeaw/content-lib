/**
 * Collection factory for test fixtures.
 *
 * This is copied verbatim into the fixture directory and imported natively by the content processor,
 * so it must be plain javascript without any dependency on the workspace.
 */

import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Records a `read()` or `transform()` call, so tests can assert which items were processed.
 *
 * Written to the fixture root, which no collection watches.
 */
async function record(kind, name, id) {
	await fs.appendFile("calls.log", `${kind} ${name} ${id}\n`, { encoding: "utf-8" });
}

export function createTestCollection(name, options = {}) {
	const {
		readDelayMs = 0,
		readsOtherCollections = false,
		readsOwnCollectionData = false,
		transformDelayMs = 0,
	} = options;

	return {
		name,
		directory: `content/${name}`,
		include: ["**/*.md"],
		async read(item) {
			await record("read", name, item.id);

			const content = await fs.readFile(item.absoluteFilePath, { encoding: "utf-8" });

			/** Widens the window in which the item can change again while it is being read. */
			if (readDelayMs > 0) {
				await delay(readDelayMs);
			}

			return content;
		},
		async transform(content, item, context) {
			await record("transform", name, item.id);

			if (readsOtherCollections) {
				/** Reading another item's data has to disable reuse of this collection's results. */
				void context.collections.length;
			}

			if (readsOwnCollectionData) {
				/** Reading sibling items of the same collection has to disable reuse just the same. */
				void context.collection.data.size;
			}

			/** Widens the window in which a generation can be superseded by a newer one. */
			if (transformDelayMs > 0) {
				await delay(transformDelayMs);
			}

			return {
				id: item.id,
				body: context.createJavaScriptImport(`export default ${JSON.stringify(content)};`),
			};
		},
	};
}
