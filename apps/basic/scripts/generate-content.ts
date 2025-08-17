import { parseArgs } from "node:util";

import { createCollection, createConfig, createContentProcessor } from "@acdh-oeaw/content-lib";
import { log } from "@acdh-oeaw/lib";
import { compile } from "@mdx-js/mdx";
import withGfm from "remark-gfm";
import { read } from "to-vfile";
import * as v from "valibot";
import { matter } from "vfile-matter";

const config = createConfig({
	collections: [
		createCollection({
			name: "people",
			directory: "./content/people/",
			include: ["*.md"],
			async read(item) {
				const vfile = await read(item.absoluteFilePath);
				matter(vfile, { strip: true });
				const metadata = v.parse(
					v.object({
						name: v.pipe(v.string(), v.nonEmpty()),
					}),
					vfile.data.matter,
				);
				const content = String(vfile);
				return { content, metadata };
			},
			async transform(data, item, context) {
				const vfile = await compile(
					{ path: item.filePath, value: data.content },
					{
						format: "md",
						jsx: true,
						remarkPlugins: [withGfm],
					},
				);
				const metadata = data.metadata;
				const content = String(vfile);
				const module = context.createJavaScriptImport(content);
				return { content: module, metadata };
			},
		}),
		createCollection({
			name: "posts",
			directory: "./content/posts/",
			include: ["*/index.md"],
			async read(item) {
				const vfile = await read(item.absoluteFilePath);
				matter(vfile, { strip: true });
				const metadata = v.parse(
					v.object({
						title: v.pipe(v.string(), v.nonEmpty()),
						authors: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty())), v.minLength(1)),
					}),
					vfile.data.matter,
				);
				const content = String(vfile);
				return { content, metadata };
			},
			async transform(data, item, context) {
				const vfile = await compile(
					{ path: item.filePath, value: data.content },
					{
						format: "md",
						jsx: true,
						remarkPlugins: [withGfm],
					},
				);
				const metadata = data.metadata;
				const content = String(vfile);
				const module = context.createJavaScriptImport(content);
				return { content: module, metadata };
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
