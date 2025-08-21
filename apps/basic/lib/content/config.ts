import { createConfig } from "@acdh-oeaw/content-lib";

import { empty } from "@/lib/content/collections/empty";
import { people } from "@/lib/content/collections/people";
import { posts } from "@/lib/content/collections/posts";

export const config = createConfig({
	collections: [empty, people, posts],
});
