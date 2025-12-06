import type * as runtime from "react/jsx-runtime";

declare module "mdx/types" {
	namespace JSX {
		type ElementType = runtime.JSX.ElementType;
		interface Element extends runtime.JSX.Element {}
		interface ElementClass extends runtime.JSX.ElementClass {}
		interface IntrinsicElements extends runtime.JSX.IntrinsicElements {}
	}
}
