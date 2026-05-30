import { TFile } from "obsidian";

export interface FrontmatterRule {
	key: string;
	value?: string; // if omitted, matches any file that has the key
}

export interface ChainDefinition {
	name: string;
	idKey: string;
	positionKey: string;
	statusKey: string;
	currentStatusValue: string;
	completedStatusValue: string;
	// Per-chain item creation config (each falls back to global task settings if omitted)
	itemFolder?: string;
	itemTemplatePath?: string;
	itemFrontmatterKey?: string;
	itemFrontmatterValue?: string;
	// When set, completed tasks are automatically appended to this chain (matched by idKey)
	completionChainIdKey?: string;
	// Auto-populate: scan vault and add matching files to this chain
	autoPopulateEnabled?: boolean;
	autoPopulateInclude?: FrontmatterRule[]; // all rules must match
	autoPopulateExclude?: FrontmatterRule[]; // any rule matching = file excluded
}

export interface ChainItem {
	file: TFile;
	order: number;
	role: "previous" | "current" | "next";
}
