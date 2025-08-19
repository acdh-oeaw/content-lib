import people from "@content/people";
import posts from "@content/posts";

interface CollectionClient<T extends { document: unknown }> {
	ids: () => Array<string>;
	all: () => Array<T["document"]>;
	byId: () => Map<string, T["document"]>;
	get: (id: string) => T["document"] | null;
}

function createCollectionClient<T extends { document: unknown }>(
	values: Map<string, T>,
	compare?: (a: T, z: T) => number,
): CollectionClient<T> {
	return {
		ids() {
			return Array.from(values.keys());
		},
		all() {
			return Array.from(values.values())
				.sort(compare)
				.map((entry) => {
					return entry.document;
				});
		},
		byId() {
			return new Map(
				Array.from(values).map(([id, value]) => {
					return [id, value.document];
				}),
			);
		},
		get(id: string) {
			return values.get(id)?.document ?? null;
		},
	};
}

// interface SingletonClient<T extends { document: unknown }> {
// 	get: () => T["document"];
// }

// function createSingletonClient<T extends { document: unknown }>(
// 	values: Map<string, T>,
// ): SingletonClient<T> {
// 	return {
// 		get() {
// 			return values.get("")!.document;
// 		},
// 	};
// }

export const client = {
	people: createCollectionClient(people),
	posts: createCollectionClient(posts),
};
