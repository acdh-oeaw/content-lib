import { assert } from "@acdh-oeaw/lib";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { client } from "@/lib/content/client";

interface PostPageProps extends PageProps<"/[id]"> {}

export default async function PostPage(props: Readonly<PostPageProps>): Promise<ReactNode> {
	const { id } = await props.params;

	const post = client.posts.get(id);

	if (!post) {
		notFound();
	}

	const { title } = post.metadata;

	const authors = post.metadata.authors.map((id) => {
		const author = client.people.get(id);
		assert(author, `Invalid person "${id}".`);
		return author.metadata.name;
	});

	const Content = post.content;

	const list = new Intl.ListFormat("en");

	return (
		<main>
			<h1>{title}</h1>
			<p>by {list.format(authors)}</p>
			<Content />
		</main>
	);
}
