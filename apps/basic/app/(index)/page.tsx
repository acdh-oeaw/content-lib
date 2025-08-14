import Link from "next/link";
import type { ReactNode } from "react";

import { posts } from "@/lib/content";

export default function PostsPage(): ReactNode {
	return (
		<main>
			<h1>Posts</h1>
			<ul role="list">
				{Array.from(posts).map(([id, post]) => {
					const { title } = post.document.metadata;

					return (
						<li key={id}>
							<article>
								<h2>
									<Link href={`/${id}`}>{title}</Link>
								</h2>
							</article>
						</li>
					);
				})}
			</ul>
		</main>
	);
}
