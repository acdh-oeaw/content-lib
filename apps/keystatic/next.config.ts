import type { NextConfig as Config } from "next";

const config: Config = {
	allowedDevOrigins: ["127.0.0.1"],
	redirects() {
		const redirects: Awaited<ReturnType<NonNullable<Config["redirects"]>>> = [
			{
				source: "/admin",
				destination: "/keystatic",
				permanent: false,
			},
		];

		return Promise.resolve(redirects);
	},
	typedRoutes: true,
	typescript: {
		ignoreBuildErrors: true,
	},
};

export default config;
