import { collection as createCollection, fields } from "@keystatic/core";

export const posts = createCollection({
	label: "Posts",
	slugField: "title",
	path: "content/posts/*/",
	format: { contentField: "content" },
	schema: {
		title: fields.slug({
			name: {
				label: "Title",
				validation: { isRequired: true },
			},
		}),
		authors: fields.multiRelationship({
			label: "Authors",
			collection: "people",
			validation: { length: { min: 1 } },
		}),
		content: fields.mdx({
			label: "Content",
		}),
	},
});
