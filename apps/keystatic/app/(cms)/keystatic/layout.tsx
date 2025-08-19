import type { Metadata } from "next";
import type { ReactNode } from "react";

import KeystaticApp from "@/app/(cms)/keystatic/keystatic";

const locale = "en";

export const metadata: Metadata = {
	title: "CMS",
	robots: {
		index: false,
	},
};

export default function CmsLayout(): ReactNode {
	return (
		<html lang={locale}>
			<body>
				<KeystaticApp />
			</body>
		</html>
	);
}
