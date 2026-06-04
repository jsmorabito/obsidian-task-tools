import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Override no-misused-promises for TS files: Obsidian API callbacks are
		// typed () => void but plugins must use async — suppressing argument checks
		// avoids pervasive false positives that can't be fixed without rewriting all
		// event handler signatures.
		files: ['**/*.ts', '**/*.tsx'],
		plugins: { '@typescript-eslint': tseslint.plugin },
		rules: {
			"@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
