import { TFile } from "obsidian";

// ── Linear integration ─────────────────────────────────────────────────────

export type LinearAuthType = "apiKey" | "oauth";

export interface LinearWorkspaceConfig {
	/** User-assigned slug, e.g. "acme" or "personal". Used as the key in frontmatter. */
	id: string;
	/** Display name shown in the UI. */
	name: string;
	authType: LinearAuthType;
	/** Personal API key — used when authType === "apiKey". */
	apiKey?: string;
	/** OAuth access token — stored after completing the OAuth flow. */
	oauthToken?: string;
	/** OAuth refresh token — stored after completing the OAuth flow. */
	oauthRefreshToken?: string;
}

export interface LinearIssueStub {
	id: string;           // Linear UUID
	identifier: string;   // e.g. "ENG-42"
	title: string;
	url: string;
	stateName: string;
	stateType: string;    // "backlog" | "unstarted" | "started" | "completed" | "cancelled"
	priority: number;     // 0 = no priority, 1 = urgent, 2 = high, 3 = medium, 4 = low
	teamId: string;
	teamName: string;
	workspaceId: string;  // maps to LinearWorkspaceConfig.id
}

export interface LinearTeam {
	id: string;
	name: string;
	key: string;
}

// ── Existing types ─────────────────────────────────────────────────────────

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
	readyStatusValue?: string;
	inProgressStatusValue?: string;
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
	// Linear: when set, restricts the Linear panel to this workspace and defaults imports to it
	linearWorkspaceId?: string;
}

export interface ChainItem {
	file: TFile;
	order: number;
	role: "previous" | "current" | "ready" | "inProgress" | "next";
}
