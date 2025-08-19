import { collection as createCollection, fields } from "@keystatic/core";

export const people = createCollection({
	label: "People",
	slugField: "name",
	path: "content/people/*",
	format: { contentField: "content" },
	schema: {
		name: fields.slug({
			name: {
				label: "Name",
				validation: { isRequired: true },
			},
		}),
		content: fields.mdx({
			label: "Content",
		}),
	},
});
