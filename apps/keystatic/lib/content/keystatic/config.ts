import { config as createConfig } from "@keystatic/core";

import { people } from "@/lib/content/keystatic/collections/people";
import { posts } from "@/lib/content/keystatic/collections/posts";

export const config = createConfig({
	storage: {
		kind: "local",
	},
	collections: {
		posts,
		people,
	},
});
