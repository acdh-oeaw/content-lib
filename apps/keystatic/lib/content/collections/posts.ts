import { createCollection } from "@acdh-oeaw/content-lib";
import { compile } from "@mdx-js/mdx";
import type { MDXContent } from "mdx/types";
import withGfm from "remark-gfm";
import { VFile } from "vfile";

import { reader } from "@/lib/content/keystatic/reader";

export const posts = createCollection({
	name: "posts",
	directory: "./content/posts/",
	include: ["*/index.mdx"],
	read(item) {
		return reader.collections.posts.readOrThrow(item.id, { resolveLinkedFiles: true });
	},
	async transform(data, item, context) {
		const { content, ...metadata } = data;
		const input = new VFile({ path: item.filePath, value: content });
		const output = await compile(input, {
			format: "mdx",
			jsx: true,
			remarkPlugins: [withGfm],
		});
		const module = context.createJavaScriptImport<MDXContent>(String(output));
		return { id: item.id, content: module, metadata };
	},
});
