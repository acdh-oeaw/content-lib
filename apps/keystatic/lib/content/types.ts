import type { components } from "@/lib/content/mdx-components";

declare global {
	type MDXProvidedComponents = typeof components;
}
