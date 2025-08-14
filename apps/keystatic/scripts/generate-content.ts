import { parseArgs } from "node:util";

import { createCollection, createConfig, createContentProcessor } from "@acdh-oeaw/content-lib";
import { log } from "@acdh-oeaw/lib";
import { createReader } from "@keystatic/core/reader";
import { compile } from "@mdx-js/mdx";
import withGfm from "remark-gfm";
import * as v from "valibot";

import keystaticConfig from "../keystatic.config.ts";

const reader = createReader(process.cwd(), keystaticConfig);

const config = createConfig({
	collections: [
		createCollection({
			name: "people",
			directory: "content/people",
			include: ["*.mdx"],
			read(item) {
				return reader.collections.people.readOrThrow(item.id, { resolveLinkedFiles: true });
			},
			async transform(data, item, context) {
				const vfile = await compile(
					{ path: item.filePath, value: data.content },
					{
						format: "mdx",
						jsx: true,
						remarkPlugins: [withGfm],
					},
				);
				const content = String(vfile);
				const module = context.createJavaScriptImport(content);
				return { ...data, content: module };
			},
		}),
		createCollection({
			name: "posts",
			directory: "content/posts",
			include: ["*/index.mdx"],
			read(item) {
				return reader.collections.posts.readOrThrow(item.id, { resolveLinkedFiles: true });
			},
			async transform(data, item, context) {
				const vfile = await compile(
					{ path: item.filePath, value: data.content },
					{
						format: "mdx",
						jsx: true,
						remarkPlugins: [withGfm],
					},
				);
				const content = String(vfile);
				const module = context.createJavaScriptImport(content);
				return { ...data, content: module };
			},
		}),
	],
});

export async function generate(): Promise<void> {
	const { positionals } = parseArgs({ allowPositionals: true });
	const mode = v.parse(v.optional(v.picklist(["build", "watch"]), "build"), positionals.at(0));

	let start = performance.now();
	const processor = await createContentProcessor(config);
	let duration = performance.now() - start;
	log.info(`Created content processor in ${duration.toFixed(2)} ms.`);

	start = performance.now();
	const stats = await processor.build();
	duration = performance.now() - start;
	log.success(
		`Processed ${String(stats.documents)} documents in ${String(stats.collections)} collections in ${duration.toFixed(2)} ms.`,
	);

	if (mode === "watch") {
		log.info("Watching for changes...");
		await processor.watch();
	}
}

generate().catch((error: unknown) => {
	log.error("Failed to generate content.\n", error);
});
