import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { ContentProcessor } from "../src/index.ts";
import { createFixture, type Fixture } from "./helpers/fixture.ts";

async function waitFor(
	predicate: () => Promise<boolean>,
	message: string,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}

		await delay(25);
	}

	throw new Error(`Timed out waiting for ${message}.`);
}

/**
 * Content of every content-hashed module of a collection.
 *
 * Modules which disappear while reading are skipped: the output tree may be regenerating.
 */
async function readCollectionModules(
	fixture: Fixture,
	collectionName: string,
): Promise<Array<string>> {
	const files = await fixture.listGenerated();

	const contents = await Promise.all(
		files
			.filter((filePath) => {
				return filePath.startsWith(`${collectionName}/`) && filePath.endsWith(".jsx");
			})
			.map((filePath) => {
				return fixture.readGenerated(filePath).catch(() => {
					return null;
				});
			}),
	);

	return contents.filter((content) => {
		return content != null;
	});
}

function includes(value: string): (content: string) => boolean {
	return (content) => {
		return content.includes(value);
	};
}

/** Whether `idle()` resolves right away, i.e. the processor currently has no pending work. */
function isIdle(processor: ContentProcessor): Promise<boolean> {
	return Promise.race([
		processor.idle().then(() => {
			return true;
		}),
		/** A macrotask, so it always loses against an already resolved `idle()`. */
		delay(0, false),
	]);
}

/** Subscribes to changes, and closes again while the watched directory still exists. */
async function startWatching(fixture: Fixture, processor: ContentProcessor): Promise<void> {
	await processor.watch();

	fixture.onCleanup(async () => {
		await processor.close();
	});
}

describe("watch", () => {
	it("regenerates a collection when one of its items changes", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();
		await startWatching(fixture, processor);

		const before = await fixture.statGenerated();

		await fixture.writeFile("content/posts/first-post.md", "The first post, edited.");

		await waitFor(async () => {
			const files = await fixture.listGenerated();

			for (const filePath of files) {
				if (!filePath.endsWith(".jsx")) {
					continue;
				}

				if ((await fixture.readGenerated(filePath)).includes("edited")) {
					return true;
				}
			}

			return false;
		}, "the edited item to be published");

		/** The index has to catch up with the module it references. */
		await waitFor(async () => {
			return (await fixture.statGenerated()).get("posts/index.js") !== before.get("posts/index.js");
		}, "the collection index to be republished");

		const after = await fixture.statGenerated();

		/** Collections which did not change must not be touched at all. */
		for (const [entryPath, value] of before) {
			if (entryPath === "people" || entryPath.startsWith("people/")) {
				expect(after.get(entryPath), entryPath).toBe(value);
			}
		}

		expect(after.get("posts/index.d.ts")).toBe(before.get("posts/index.d.ts"));
	});

	it("publishes an item which it has not seen being created", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();

		/**
		 * The item is created before the watcher subscribes, so the processor only ever receives an
		 * "update" event for a file which is not in its collection data yet.
		 *
		 * This also happens while editing normally: creating a file emits both a "create" and an
		 * "update" event, and the debounce batch is keyed by path, so only the "update" event survives.
		 */
		await fixture.writeFile("content/posts/third-post.md", "The third post.");

		await startWatching(fixture, processor);

		const before = await fixture.listGenerated();

		await fixture.writeFile("content/posts/third-post.md", "The third post, edited.");

		await waitFor(async () => {
			return (await fixture.readIndexImports("posts")).length === 3;
		}, "the new item to be published");

		await expect(fixture.listGenerated()).resolves.toHaveLength(before.length + 1);
	});

	it("applies simultaneous events from different collections to the correct collections", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();
		await startWatching(fixture, processor);

		/**
		 * Both writes land in the same debounce batch, which is processed by whichever collection
		 * scheduled the timer. The shared item id additionally collides across collections.
		 */
		await fixture.writeFile("content/people/shared.md", "A shared person.");
		await fixture.writeFile("content/posts/shared.md", "A shared post.");

		await waitFor(async () => {
			const [people, posts] = await Promise.all([
				fixture.readIndexImports("people"),
				fixture.readIndexImports("posts"),
			]);

			return people.length === 2 && posts.length === 3;
		}, "both new items to be published");

		const people = await readCollectionModules(fixture, "people");
		const posts = await readCollectionModules(fixture, "posts");

		/** Each item must be resolved against its own collection directory. */
		expect(people.some(includes("A shared person."))).toBe(true);
		expect(people.some(includes("A shared post."))).toBe(false);
		expect(posts.some(includes("A shared post."))).toBe(true);
		expect(posts.some(includes("A shared person."))).toBe(false);
	});

	it("publishes the latest values when items change repeatedly", async () => {
		const itemCount = 40;

		async function writeAll(value: string): Promise<void> {
			for (let index = 0; index < itemCount; index++) {
				await fixture.writeFile(
					`content/posts/post-${String(index)}.md`,
					`Post ${String(index)} value ${value}.`,
				);
			}
		}

		const files: Record<string, string> = {};

		for (let index = 0; index < itemCount; index++) {
			files[`content/posts/post-${String(index)}.md`] = `Post ${String(index)} value A.`;
		}

		/**
		 * Enough items and enough delay that a generation is still reading and transforming when the
		 * next one is requested, and that work actually queues up in the shared concurrency limiter.
		 */
		const fixture = await createFixture({
			collectionNames: ["posts"],
			files,
			transformDelayMs: 100,
		});
		const processor = await fixture.createProcessor();

		await processor.build();
		await startWatching(fixture, processor);

		async function waitForValue(value: string): Promise<void> {
			await waitFor(async () => {
				const modules = await readCollectionModules(fixture, "posts");

				return modules.filter(includes(`value ${value}.`)).length === itemCount;
			}, `every item to be published with value ${value}`);
		}

		await writeAll("B");
		await waitForValue("B");

		/**
		 * The last change supersedes a generation which is still transforming, so nothing runs after it
		 * which could paper over a superseded generation taking the new one down with it.
		 */
		await writeAll("C");
		await delay(400);
		await writeAll("D");

		await waitForValue("D");

		/** No superseded generation may publish after the latest one. */
		await delay(1_000);

		const published = await Promise.all(
			(await fixture.readIndexImports("posts")).map((specifier) => {
				return fixture.readGenerated(path.join("posts", specifier));
			}),
		);

		expect(published).toHaveLength(itemCount);

		for (let index = 0; index < itemCount; index++) {
			expect(published.filter(includes(`Post ${String(index)} value D.`))).toHaveLength(1);
		}
	});

	it("regenerates a collection when an item is added and when it is removed", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();
		await startWatching(fixture, processor);

		const before = await fixture.listGenerated();

		await fixture.writeFile("content/posts/third-post.md", "The third post.");

		await waitFor(async () => {
			return (await fixture.listGenerated()).length === before.length + 1;
		}, "the added item to be published");

		await fixture.removeFile("content/posts/third-post.md");

		await waitFor(async () => {
			return (await fixture.listGenerated()).length === before.length;
		}, "the removed item to be unpublished");

		await expect(fixture.listGenerated()).resolves.toEqual(before);
	});
});

describe("incremental regeneration", () => {
	it("only re-reads and re-transforms the item which changed", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();
		await startWatching(fixture, processor);
		await fixture.clearCalls();

		await fixture.writeFile("content/posts/first-post.md", "The first post, edited.");

		await waitFor(async () => {
			return (await readCollectionModules(fixture, "posts")).some(includes("edited"));
		}, "the edited item to be published");

		await processor.idle();

		await expect(fixture.readCalls()).resolves.toEqual([
			"read posts first-post",
			"transform posts first-post",
		]);
	});

	it("does not re-read or re-transform anything when an item is deleted", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();
		await startWatching(fixture, processor);
		await fixture.clearCalls();

		await fixture.removeFile("content/posts/second-post.md");

		await waitFor(async () => {
			return (await fixture.readIndexImports("posts")).length === 1;
		}, "the deleted item to be unpublished");

		await processor.idle();

		await expect(fixture.readCalls()).resolves.toEqual([]);
	});

	it("re-reads and re-transforms everything on a build", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();
		await fixture.clearCalls();

		await processor.build();

		await expect(fixture.readCalls()).resolves.toEqual([
			"read people jane-doe",
			"read posts first-post",
			"read posts second-post",
			"transform people jane-doe",
			"transform posts first-post",
			"transform posts second-post",
		]);
	});

	it("does not reuse a read which finished after the item changed again", async () => {
		const fixture = await createFixture({ collectionNames: ["posts"], readDelayMs: 600 });
		const processor = await fixture.createProcessor();

		await processor.build();
		await startWatching(fixture, processor);

		/**
		 * The second write lands while the first one is still being read. When that read finishes it
		 * must not be written back, otherwise the item looks up to date while holding the content from
		 * before the second write, and so is never read again.
		 */
		await fixture.writeFile("content/posts/first-post.md", "The first post, B.");
		await delay(300);
		await fixture.writeFile("content/posts/first-post.md", "The first post, C.");

		await waitFor(async () => {
			return (await readCollectionModules(fixture, "posts")).some(includes("The first post, C."));
		}, "the latest content to be published");

		await processor.idle();
		await delay(500);

		const modules = await readCollectionModules(fixture, "posts");

		expect(modules.some(includes("The first post, C."))).toBe(true);
		expect(modules.some(includes("The first post, B."))).toBe(false);
	});

	it("re-transforms a whole collection whose transform reads other collections", async () => {
		const fixture = await createFixture({ readsOtherCollections: ["posts"] });
		const processor = await fixture.createProcessor();

		await processor.build();
		await startWatching(fixture, processor);
		await fixture.clearCalls();

		await fixture.writeFile("content/people/jane-doe.md", "Jane Doe, edited.");

		await waitFor(async () => {
			return (await readCollectionModules(fixture, "people")).some(includes("edited"));
		}, "the edited item to be published");

		await processor.idle();

		/**
		 * "posts" reads other collections, so all of it is transformed again. Nothing is read again
		 * except the item which actually changed, because `read()` only sees its own item.
		 */
		await expect(fixture.readCalls()).resolves.toEqual([
			"read people jane-doe",
			"transform people jane-doe",
			"transform posts first-post",
			"transform posts second-post",
		]);
	});
});

describe("error handling", () => {
	it("keeps watching when applying an event fails", async () => {
		const fixture = await createFixture({ collectionNames: ["posts"] });
		const processor = await fixture.createProcessor();

		await processor.build();
		await startWatching(fixture, processor);

		/**
		 * A symlink pointing at itself. `fs.stat()` follows symlinks and fails with `ELOOP`, which is
		 * not the `ENOENT` the watcher tolerates, so applying this event throws.
		 */
		await fixture.writeSymlink("content/posts/loop.md", "loop.md");

		await waitFor(async () => {
			return !(await isIdle(processor));
		}, "the symlink to reach the watcher");

		/** Without error handling the throw escapes as an unhandled rejection, and this never settles. */
		await processor.idle();

		/** The watcher has to still be alive afterwards. */
		await fixture.writeFile("content/posts/first-post.md", "The first post, edited.");

		await waitFor(async () => {
			return (await readCollectionModules(fixture, "posts")).some(includes("edited"));
		}, "a later change to still be published");
	});
});

describe("idle", () => {
	it("resolves immediately when nothing is pending", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();

		await expect(processor.idle()).resolves.toBeUndefined();

		await startWatching(fixture, processor);

		await expect(processor.idle()).resolves.toBeUndefined();
	});

	it("resolves only once a regeneration triggered by a change has completed", async () => {
		const fixture = await createFixture({ transformDelayMs: 50 });
		const processor = await fixture.createProcessor();

		await processor.build();
		await startWatching(fixture, processor);

		await fixture.writeFile("content/posts/first-post.md", "The first post, edited.");

		/** Wait until the watcher has been told about the change, which `idle()` cannot know about. */
		await waitFor(async () => {
			return !(await isIdle(processor));
		}, "the change to reach the watcher");

		await processor.idle();

		const modules = await readCollectionModules(fixture, "posts");

		expect(modules.some(includes("The first post, edited."))).toBe(true);
	});
});

describe("close", () => {
	it("can be called without watching, and more than once", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();

		await expect(processor.close()).resolves.toBeUndefined();
		await expect(processor.close()).resolves.toBeUndefined();
	});

	it("waits for an in-flight regeneration, leaving a complete output tree", async () => {
		const fixture = await createFixture({ transformDelayMs: 50 });
		const processor = await fixture.createProcessor();

		await processor.build();
		await startWatching(fixture, processor);

		const before = await fixture.listGenerated();

		await fixture.writeFile("content/posts/third-post.md", "The third post.");

		/** Close while the regeneration triggered by the change is still running. */
		await waitFor(async () => {
			return !(await isIdle(processor));
		}, "the change to reach the watcher");

		await processor.close();

		/** Whether or not the change made it, what is on disk has to be complete and consistent. */
		const files = await fixture.listGenerated();

		expect(
			files.filter((filePath) => {
				return filePath.endsWith(".tmp");
			}),
		).toEqual([]);
		expect(files.length).toBeGreaterThanOrEqual(before.length);

		for (const collectionName of ["people", "posts"]) {
			const specifiers = await fixture.readIndexImports(collectionName);

			for (const specifier of specifiers) {
				await expect(
					fixture.readGenerated(path.join(collectionName, specifier)),
				).resolves.toBeTypeOf("string");
			}
		}

		/** Nothing may be published after closing. */
		const after = await fixture.statGenerated();
		await delay(500);

		expect(await fixture.statGenerated()).toEqual(after);
	});
});
