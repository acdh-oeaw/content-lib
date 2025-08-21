import type { ReactNode } from "react";

import { client } from "@/lib/content/client";

export default function EmptyPage(): ReactNode {
	return (
		<main>
			<h1>Items</h1>
			<ul role="list">
				{client.empty.all().map((item) => {
					return <li key={item.id}>{item.metadata.name}</li>;
				})}
			</ul>
		</main>
	);
}
