
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/private';
 * 
 * console.log(ENVIRONMENT); // => "production"
 * console.log(PUBLIC_BASE_URL); // => throws error during build
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/private' {
	export const SPACESHIP_VERSION: string;
	export const MANPATH: string;
	export const CLAUDE_CODE_MESSAGING_TOKEN: string;
	export const NoDefaultCurrentDirectoryInExePath: string;
	export const TERM_PROGRAM: string;
	export const CLAUDE_EFFORT: string;
	export const CLAUDE_CODE_ENTRYPOINT: string;
	export const NODE: string;
	export const SSL_CERT_FILE: string;
	export const INIT_CWD: string;
	export const TERM: string;
	export const SHELL: string;
	export const TMPDIR: string;
	export const CLAUDE_PID: string;
	export const CLAUDE_CODE_CHILD_SESSION: string;
	export const npm_config_global_prefix: string;
	export const LIBRARY_PATH: string;
	export const TERM_PROGRAM_VERSION: string;
	export const FLOX_ENV: string;
	export const FLOX_CONFIG_DIR: string;
	export const COLOR: string;
	export const TERM_SESSION_ID: string;
	export const npm_config_noproxy: string;
	export const npm_config_local_prefix: string;
	export const GIT_EDITOR: string;
	export const FLOX_PROMPT_COLOR_1: string;
	export const AI_AGENT: string;
	export const _activate_d: string;
	export const USER: string;
	export const BUILDENV_NIX: string;
	export const FLOX_PROMPT_COLOR_2: string;
	export const npm_config_globalconfig: string;
	export const _flox_activate_tracelevel: string;
	export const FLOX_SENTRY_DSN: string;
	export const SSH_AUTH_SOCK: string;
	export const CPATH: string;
	export const __CF_USER_TEXT_ENCODING: string;
	export const npm_execpath: string;
	export const PROCESS_COMPOSE_BIN: string;
	export const FLOX_ENV_PROJECT: string;
	export const _FLOX_ACTIVATIONS_VERBOSITY: string;
	export const PATH: string;
	export const npm_package_json: string;
	export const _: string;
	export const PROJECT_NAME: string;
	export const LaunchInstanceID: string;
	export const npm_config_userconfig: string;
	export const npm_config_init_module: string;
	export const __CFBundleIdentifier: string;
	export const npm_command: string;
	export const PWD: string;
	export const FLOX_ENV_DIRS: string;
	export const npm_lifecycle_event: string;
	export const EDITOR: string;
	export const npm_package_name: string;
	export const LANG: string;
	export const FLOX_ENV_DESCRIPTION: string;
	export const PATH_LOCALE: string;
	export const npm_config_npm_version: string;
	export const XPC_FLAGS: string;
	export const NIX_SSL_CERT_FILE: string;
	export const npm_package_engines_node: string;
	export const npm_config_node_gyp: string;
	export const _FLOX_SUBSYSTEM_VERBOSITY: string;
	export const _FLOX_ENV_CUDA_DETECTION: string;
	export const npm_package_version: string;
	export const XPC_SERVICE_NAME: string;
	export const SPACESHIP_ROOT: string;
	export const FLOX_ACTIVATE_START_SERVICES: string;
	export const _flox_activate_tracer: string;
	export const SHLVL: string;
	export const HOME: string;
	export const NIX_BIN: string;
	export const CLAUDE_CODE_EXECPATH: string;
	export const ATUIN_HISTORY_ID: string;
	export const npm_config_cache: string;
	export const LOGNAME: string;
	export const npm_lifecycle_script: string;
	export const NIX_PLUGINS: string;
	export const ATUIN_SESSION: string;
	export const XDG_DATA_DIRS: string;
	export const FLOX_PROMPT_ENVIRONMENTS: string;
	export const COREPACK_ENABLE_AUTO_PIN: string;
	export const PKG_CONFIG_PATH: string;
	export const npm_config_user_agent: string;
	export const FLOX_ENV_CACHE: string;
	export const INFOPATH: string;
	export const CLAUDE_CODE_SESSION_ID: string;
	export const ACLOCAL_PATH: string;
	export const _FLOX_ACTIVE_ENVIRONMENTS: string;
	export const OSLogRateLimit: string;
	export const SECURITYSESSIONID: string;
	export const CLAUDE_CODE_MESSAGING_SOCKET: string;
	export const CLAUDECODE: string;
	export const _FLOX_SET_PROMPT: string;
	export const npm_node_execpath: string;
	export const npm_config_prefix: string;
	export const FLOX_SENTRY_ENV: string;
	export const COLORTERM: string;
	export const NODE_ENV: string;
}

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/public';
 * 
 * console.log(ENVIRONMENT); // => throws error during build
 * console.log(PUBLIC_BASE_URL); // => "http://site.com"
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * 
 * console.log(env.ENVIRONMENT); // => "production"
 * console.log(env.PUBLIC_BASE_URL); // => undefined
 * ```
 */
declare module '$env/dynamic/private' {
	export const env: {
		SPACESHIP_VERSION: string;
		MANPATH: string;
		CLAUDE_CODE_MESSAGING_TOKEN: string;
		NoDefaultCurrentDirectoryInExePath: string;
		TERM_PROGRAM: string;
		CLAUDE_EFFORT: string;
		CLAUDE_CODE_ENTRYPOINT: string;
		NODE: string;
		SSL_CERT_FILE: string;
		INIT_CWD: string;
		TERM: string;
		SHELL: string;
		TMPDIR: string;
		CLAUDE_PID: string;
		CLAUDE_CODE_CHILD_SESSION: string;
		npm_config_global_prefix: string;
		LIBRARY_PATH: string;
		TERM_PROGRAM_VERSION: string;
		FLOX_ENV: string;
		FLOX_CONFIG_DIR: string;
		COLOR: string;
		TERM_SESSION_ID: string;
		npm_config_noproxy: string;
		npm_config_local_prefix: string;
		GIT_EDITOR: string;
		FLOX_PROMPT_COLOR_1: string;
		AI_AGENT: string;
		_activate_d: string;
		USER: string;
		BUILDENV_NIX: string;
		FLOX_PROMPT_COLOR_2: string;
		npm_config_globalconfig: string;
		_flox_activate_tracelevel: string;
		FLOX_SENTRY_DSN: string;
		SSH_AUTH_SOCK: string;
		CPATH: string;
		__CF_USER_TEXT_ENCODING: string;
		npm_execpath: string;
		PROCESS_COMPOSE_BIN: string;
		FLOX_ENV_PROJECT: string;
		_FLOX_ACTIVATIONS_VERBOSITY: string;
		PATH: string;
		npm_package_json: string;
		_: string;
		PROJECT_NAME: string;
		LaunchInstanceID: string;
		npm_config_userconfig: string;
		npm_config_init_module: string;
		__CFBundleIdentifier: string;
		npm_command: string;
		PWD: string;
		FLOX_ENV_DIRS: string;
		npm_lifecycle_event: string;
		EDITOR: string;
		npm_package_name: string;
		LANG: string;
		FLOX_ENV_DESCRIPTION: string;
		PATH_LOCALE: string;
		npm_config_npm_version: string;
		XPC_FLAGS: string;
		NIX_SSL_CERT_FILE: string;
		npm_package_engines_node: string;
		npm_config_node_gyp: string;
		_FLOX_SUBSYSTEM_VERBOSITY: string;
		_FLOX_ENV_CUDA_DETECTION: string;
		npm_package_version: string;
		XPC_SERVICE_NAME: string;
		SPACESHIP_ROOT: string;
		FLOX_ACTIVATE_START_SERVICES: string;
		_flox_activate_tracer: string;
		SHLVL: string;
		HOME: string;
		NIX_BIN: string;
		CLAUDE_CODE_EXECPATH: string;
		ATUIN_HISTORY_ID: string;
		npm_config_cache: string;
		LOGNAME: string;
		npm_lifecycle_script: string;
		NIX_PLUGINS: string;
		ATUIN_SESSION: string;
		XDG_DATA_DIRS: string;
		FLOX_PROMPT_ENVIRONMENTS: string;
		COREPACK_ENABLE_AUTO_PIN: string;
		PKG_CONFIG_PATH: string;
		npm_config_user_agent: string;
		FLOX_ENV_CACHE: string;
		INFOPATH: string;
		CLAUDE_CODE_SESSION_ID: string;
		ACLOCAL_PATH: string;
		_FLOX_ACTIVE_ENVIRONMENTS: string;
		OSLogRateLimit: string;
		SECURITYSESSIONID: string;
		CLAUDE_CODE_MESSAGING_SOCKET: string;
		CLAUDECODE: string;
		_FLOX_SET_PROMPT: string;
		npm_node_execpath: string;
		npm_config_prefix: string;
		FLOX_SENTRY_ENV: string;
		COLORTERM: string;
		NODE_ENV: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://example.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.ENVIRONMENT); // => undefined, not public
 * console.log(env.PUBLIC_BASE_URL); // => "http://example.com"
 * ```
 * 
 * ```
 * 
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}
