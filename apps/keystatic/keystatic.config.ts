import { collection, config, fields } from "@keystatic/core";

export default config({
	storage: {
		kind: "local",
	},
	collections: {
		people: collection({
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
		}),
		posts: collection({
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
		}),
	},
});
