/** Bedrock uses Pi's native AWS authentication, separate from plain API-key providers. */
export const BEDROCK_PROVIDER = {
	id: "amazon-bedrock",
	envVar: "AWS_BEARER_TOKEN_BEDROCK",
	label: "Amazon Bedrock",
} as const;

/** Credential selectors must also be hidden by the fresh-user environment switch. */
export const BEDROCK_AUTH_ENV_VARS = [
	BEDROCK_PROVIDER.envVar,
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_ROLE_ARN",
] as const;

/** Configuration presence, not an AWS login/permission check. Pinned to Pi in tests. */
export function bedrockConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
	return Boolean(
		env.AWS_BEARER_TOKEN_BEDROCK ||
		env.AWS_PROFILE ||
		(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
		env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
		env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
		env.AWS_WEB_IDENTITY_TOKEN_FILE
	);
}
