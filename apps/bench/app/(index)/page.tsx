import Link from "next/link";
import type { ReactNode } from "react";

import { client } from "@/lib/content/client";

export default function PostsPage(): ReactNode {
	return (
		<main>
			<h1>Posts</h1>
			<ul role="list">
				{client.posts.all().map((post) => {
					const { title } = post.metadata;

					return (
						<li key={post.id}>
							<article>
								<h2>
									<Link href={`/${post.id}`}>{title}</Link>
								</h2>
							</article>
						</li>
					);
				})}
			</ul>
		</main>
	);
}
