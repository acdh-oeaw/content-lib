import { createCollection } from "@acdh-oeaw/content-lib";
import { compile } from "@mdx-js/mdx";
import withGfm from "remark-gfm";
import { read } from "to-vfile";
import * as v from "valibot";
import { matter } from "vfile-matter";

export const people = createCollection({
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
		return { content: module, metadata, id: item.id };
	},
});
