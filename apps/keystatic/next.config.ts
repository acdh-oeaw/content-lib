import type { NextConfig as Config } from "next";

const config: Config = {
	allowedDevOrigins: ["127.0.0.1"],
	eslint: {
		ignoreDuringBuilds: true,
	},
	experimental: {
		typedRoutes: true,
	},
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
	typescript: {
		ignoreBuildErrors: true,
	},
};

export default config;
