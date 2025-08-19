import "@/styles/index.css";

import type { ReactNode } from "react";

interface RootLayoutProps extends LayoutProps<"/"> {}

export default function RootLayout(props: Readonly<RootLayoutProps>): ReactNode {
	const { children } = props;

	const locale = "en";

	return (
		<html lang={locale}>
			<body>{children}</body>
		</html>
	);
}
