import Link from "next/link";
import type { ReactNode } from "react";

import { client } from "@/lib/content/client";

export default function PostsPage(): ReactNode {
	return (
		<main>
			<h1>Posts</h1>
			<ul role="list">
				{client.posts.all().map((post) => {
					const { id, metadata } = post;

					return (
						<li key={id}>
							<article>
								<h2>
									<Link href={`/${id}`}>{metadata.title}</Link>
								</h2>
							</article>
						</li>
					);
				})}
			</ul>
		</main>
	);
}
