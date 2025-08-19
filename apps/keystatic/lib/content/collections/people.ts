import { createCollection } from "@acdh-oeaw/content-lib";
import { compile } from "@mdx-js/mdx";
import withGfm from "remark-gfm";
import { VFile } from "vfile";

import { reader } from "@/lib/content/keystatic/reader";

export const people = createCollection({
	name: "people",
	directory: "./content/people/",
	include: ["*.mdx"],
	read(item) {
		return reader.collections.people.readOrThrow(item.id, { resolveLinkedFiles: true });
	},
	async transform(data, item, context) {
		const { content, ...metadata } = data;
		const input = new VFile({ path: item.filePath, value: content });
		const output = await compile(input, {
			format: "mdx",
			jsx: true,
			remarkPlugins: [withGfm],
		});
		const module = context.createJavaScriptImport(String(output));
		return { id: item.id, content: module, metadata };
	},
});
