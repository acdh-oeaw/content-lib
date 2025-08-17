import { assert } from "@acdh-oeaw/lib";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { people, posts } from "@/lib/content";

interface PostPageProps extends PageProps<"/[id]"> {}

export default async function PostPage(props: Readonly<PostPageProps>): Promise<ReactNode> {
	const { id } = await props.params;

	const post = posts.get(id);

	if (!post) {
		notFound();
	}

	const { title } = post.document;

	const authors = post.document.authors.map((id) => {
		const author = people.get(id);
		assert(author, `Invalid person "${id}".`);
		return author.document.name;
	});

	const Content = post.document.content;

	const list = new Intl.ListFormat("en");

	return (
		<main>
			<h1>{title}</h1>
			<p>by {list.format(authors)}</p>
			<Content />
		</main>
	);
}
