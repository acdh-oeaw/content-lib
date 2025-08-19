import type * as runtime from "react/jsx-runtime";

import type { components } from "@/lib/content/mdx-components";

declare global {
	type MDXProvidedComponents = typeof components;
}

declare module "mdx/types" {
	namespace JSX {
		type Element = runtime.JSX.Element;
		type ElementClass = runtime.JSX.ElementClass;
		type IntrinsicElements = runtime.JSX.IntrinsicElements;
	}
}
