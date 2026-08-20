import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { createFixture, type Fixture, parseIndexImports } from "./helpers/fixture.ts";

interface EntryDiff {
	added: Array<string>;
	changed: Array<string>;
	removed: Array<string>;
}

/** Compares two `statGenerated()` snapshots by identity and modification time. */
function diffEntries(before: Map<string, string>, after: Map<string, string>): EntryDiff {
	const added: Array<string> = [];
	const changed: Array<string> = [];
	const removed: Array<string> = [];

	for (const [entryPath, value] of after) {
		if (!before.has(entryPath)) {
			added.push(entryPath);
		} else if (before.get(entryPath) !== value) {
			changed.push(entryPath);
		}
	}

	for (const entryPath of before.keys()) {
		if (!after.has(entryPath)) {
			removed.push(entryPath);
		}
	}

	return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

async function exists(filePath: string): Promise<boolean> {
	return fs.access(filePath).then(
		() => {
			return true;
		},
		() => {
			return false;
		},
	);
}

/**
 * Modules which the collection index imports, but which are not on disk.
 *
 * The index is read again afterwards, and the observation is discarded when it was republished in
 * the meantime: modules of a superseded index are expected to be pruned, and only a *live* index
 * pointing at a missing module is a violation.
 */
async function findMissingModules(
	fixture: Fixture,
	collectionName: string,
): Promise<Array<string>> {
	const index = await fixture.readIndex(collectionName);

	/** The index has not been published yet, which is not an inconsistency. */
	if (index == null) {
		return [];
	}

	const missing: Array<string> = [];

	for (const specifier of parseIndexImports(index)) {
		const filePath = path.join(fixture.outputDirectory, collectionName, specifier);

		if (!(await exists(filePath))) {
			missing.push(specifier);
		}
	}

	if (missing.length === 0) {
		return [];
	}

	return (await fixture.readIndex(collectionName)) === index ? missing : [];
}

describe("generate", () => {
	it("writes a collection index and a content-hashed module for every item", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		const stats = await processor.build();

		expect(stats).toEqual({ collections: 2, documents: 3 });

		const files = await fixture.listGenerated();

		expect(
			files.filter((filePath) => {
				return filePath.startsWith("people/");
			}),
		).toHaveLength(3);
		expect(
			files.filter((filePath) => {
				return filePath.startsWith("posts/");
			}),
		).toHaveLength(4);
		expect(files).toContain("posts/index.js");
		expect(files).toContain("posts/index.d.ts");

		await expect(findMissingModules(fixture, "posts")).resolves.toEqual([]);
		await expect(findMissingModules(fixture, "people")).resolves.toEqual([]);
	});

	it("does not remove the output directory when regenerating", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();
		const before = await fixture.statGenerated();

		await fixture.writeFile("content/posts/first-post.md", "The first post, edited.");
		await processor.build();
		const after = await fixture.statGenerated();

		/** Identity of the output root and of every collection directory must survive a rebuild. */
		expect(after.get(".")).toBe(before.get("."));
		expect(after.get("people")).toBe(before.get("people"));
		expect(after.get("posts")?.split(":")[1]).toBe(before.get("posts")?.split(":")[1]);
	});

	it("does not rewrite files which have not changed", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();
		const before = await fixture.statGenerated();

		await processor.build();
		const after = await fixture.statGenerated();

		expect(diffEntries(before, after)).toEqual({ added: [], changed: [], removed: [] });
	});

	it("only rewrites files affected by a changed item", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();
		const before = await fixture.statGenerated();

		await fixture.writeFile("content/posts/first-post.md", "The first post, edited.");
		await processor.build();
		const after = await fixture.statGenerated();

		const diff = diffEntries(before, after);

		/** The changed item gets a new content-hashed module, and the old one is dropped. */
		expect(diff.added).toHaveLength(1);
		expect(diff.removed).toHaveLength(1);
		/** The collection index is republished, which also changes its directory's timestamp. */
		expect(diff.changed).toEqual(["posts", "posts/index.js"]);

		const touched = [...diff.added, ...diff.changed, ...diff.removed];

		expect(
			touched.filter((entryPath) => {
				return entryPath.startsWith("people");
			}),
		).toEqual([]);
		expect(touched).not.toContain("posts/index.d.ts");
	});

	it("removes generated modules which are no longer referenced", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();
		const before = await fixture.listGenerated();

		await fixture.writeFile("content/posts/first-post.md", "The first post, edited.");
		await processor.build();
		const edited = await fixture.listGenerated();

		const obsolete = edited.filter((filePath) => {
			return !before.includes(filePath);
		});

		expect(obsolete).toHaveLength(1);

		await fixture.writeFile("content/posts/first-post.md", "The first post.");
		await processor.build();

		await expect(fixture.listGenerated()).resolves.toEqual(before);
		await expect(exists(path.join(fixture.outputDirectory, obsolete[0]!))).resolves.toBe(false);
	});

	it("removes generated files of items which were deleted", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();

		await fixture.removeFile("content/posts/second-post.md");
		const stats = await processor.build();

		expect(stats.documents).toBe(2);

		const files = await fixture.listGenerated();

		expect(
			files.filter((filePath) => {
				return filePath.startsWith("posts/");
			}),
		).toHaveLength(3);
		await expect(findMissingModules(fixture, "posts")).resolves.toEqual([]);
	});

	it("removes output directories of collections which no longer exist", async () => {
		const fixture = await createFixture();

		await (await fixture.createProcessor()).build();

		await expect(exists(path.join(fixture.outputDirectory, "people"))).resolves.toBe(true);

		await fixture.writeConfig(["posts"]);
		await (await fixture.createProcessor()).build();

		await expect(exists(path.join(fixture.outputDirectory, "people"))).resolves.toBe(false);
		await expect(exists(path.join(fixture.outputDirectory, "posts"))).resolves.toBe(true);
	});

	it("never publishes a collection index referencing a module which does not exist", async () => {
		const files: Record<string, string> = {};

		for (let index = 0; index < 40; index++) {
			files[`content/posts/post-${String(index)}.md`] = `Post ${String(index)}.`;
		}

		const fixture = await createFixture({ collectionNames: ["posts"], files });
		const processor = await fixture.createProcessor();

		await processor.build();

		for (let index = 0; index < 40; index++) {
			await fixture.writeFile(`content/posts/post-${String(index)}.md`, `Post ${String(index)}!`);
		}

		const observed: Array<string> = [];
		const finished = "finished" as const;

		const generation = processor.build().then(() => {
			return finished;
		});

		/** Observe the published output until the regeneration has settled. */
		let settled: typeof finished | undefined = undefined;

		while (settled !== finished) {
			observed.push(...(await findMissingModules(fixture, "posts")));
			settled = await Promise.race([generation, delay(0, undefined)]);
		}

		expect(observed).toEqual([]);
		await expect(findMissingModules(fixture, "posts")).resolves.toEqual([]);
	});

	it("does not leave temporary files behind", async () => {
		const fixture = await createFixture();
		const processor = await fixture.createProcessor();

		await processor.build();
		await fixture.writeFile("content/posts/first-post.md", "The first post, edited.");
		await processor.build();

		const files = await fixture.listGenerated();

		expect(
			files.filter((filePath) => {
				return filePath.endsWith(".tmp");
			}),
		).toEqual([]);
	});
});
