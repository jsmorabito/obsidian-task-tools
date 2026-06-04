/**
 * LinearManager — coordinates all Linear ↔ Obsidian activity.
 *
 * Responsibilities:
 *  - Hold one LinearClient per configured workspace
 *  - Import Linear issues as Obsidian notes
 *  - Push status changes from Obsidian → Linear
 *  - Pull status updates from Linear → Obsidian (manual + scheduled)
 *  - Surface errors without crashing the plugin
 */

import { App, Notice, TFile, normalizePath } from "obsidian";
import { LinearClient } from "./client";
import type { LinearIssueStub, LinearWorkspaceConfig } from "../types";
import type { TaskToolsSettings } from "../settings";

/** Frontmatter keys written to imported issue notes. */
export const LINEAR_FM = {
	workspaceId: "linear-workspace-id",
	issueId: "linear-id",
	identifier: "linear-identifier",
	url: "linear-url",
	stateName: "linear-state",
	stateType: "linear-state-type",
	priority: "linear-priority",
	teamId: "linear-team-id",
	teamName: "linear-team",
	lastSynced: "linear-synced-at",
} as const;

export class LinearManager {
	private app: App;
	private getSettings: () => TaskToolsSettings;
	private saveSettings: () => Promise<void>;
	private clients: Map<string, LinearClient> = new Map();

	constructor(
		app: App,
		getSettings: () => TaskToolsSettings,
		saveSettings: () => Promise<void>
	) {
		this.app = app;
		this.getSettings = getSettings;
		this.saveSettings = saveSettings;
	}

	// ── Client management ───────────────────────────────────────────────────

	/** Rebuild client map from current settings. Call after settings change. */
	refreshClients(): void {
		this.clients.clear();
		for (const ws of this.getSettings().linearWorkspaces) {
			const token = this.tokenFor(ws);
			if (token) this.clients.set(ws.id, new LinearClient(ws.id, token));
		}
	}

	private tokenFor(ws: LinearWorkspaceConfig): string | null {
		if (ws.authType === "apiKey" && ws.apiKey) return ws.apiKey;
		if (ws.authType === "oauth" && ws.oauthToken) return `Bearer ${ws.oauthToken}`;
		return null;
	}

	getClient(workspaceId: string): LinearClient | null {
		return this.clients.get(workspaceId) ?? null;
	}

	getConfiguredWorkspaces(): LinearWorkspaceConfig[] {
		return this.getSettings().linearWorkspaces.filter((ws) => !!this.tokenFor(ws));
	}

	// ── Import ──────────────────────────────────────────────────────────────

	/**
	 * Import a Linear issue as an Obsidian note.
	 * Returns the created/updated TFile, or null on failure.
	 */
	async importIssue(issue: LinearIssueStub): Promise<TFile | null> {
		const settings = this.getSettings();
		const folder = normalizePath(settings.linearIssueFolder || "Linear");

		// Ensure folder exists
		if (!(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder);
		}

		// Check if a note for this issue already exists (by linear-id frontmatter)
		const existing = this.findNoteForIssue(issue.id);
		if (existing) {
			await this.updateNoteFrontmatter(existing, issue);
			new Notice(`Updated "${existing.basename}" from Linear.`);
			return existing;
		}

		// Create new note
		const safeName = issue.title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
		const fileName = `${issue.identifier} ${safeName}.md`;
		const filePath = normalizePath(`${folder}/${fileName}`);

		const body = this.buildNoteBody(issue);
		const file = await this.app.vault.create(filePath, body);

		new Notice(`Imported ${issue.identifier}: ${issue.title}`);
		return file;
	}

	/** Find the vault note that has linear-id === issueId */
	findNoteForIssue(issueId: string): TFile | null {
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (fm?.[LINEAR_FM.issueId] === issueId) return file;
		}
		return null;
	}

	/** Build the initial markdown content for a newly imported issue note. */
	private buildNoteBody(issue: LinearIssueStub): string {
		const now = new Date().toISOString();
		const priorityLabel = ["No priority", "Urgent", "High", "Medium", "Low"][issue.priority] ?? "Unknown";

		const fm = [
			"---",
			`${LINEAR_FM.workspaceId}: "${issue.workspaceId}"`,
			`${LINEAR_FM.issueId}: "${issue.id}"`,
			`${LINEAR_FM.identifier}: "${issue.identifier}"`,
			`${LINEAR_FM.url}: "${issue.url}"`,
			`${LINEAR_FM.stateName}: "${issue.stateName}"`,
			`${LINEAR_FM.stateType}: "${issue.stateType}"`,
			`${LINEAR_FM.priority}: ${issue.priority}`,
			`${LINEAR_FM.teamId}: "${issue.teamId}"`,
			`${LINEAR_FM.teamName}: "${issue.teamName}"`,
			`${LINEAR_FM.lastSynced}: "${now}"`,
			"---",
		].join("\n");

		return `${fm}\n\n# ${issue.identifier}: ${issue.title}\n\n[Open in Linear](${issue.url})\n\n**Status:** ${issue.stateName}  \n**Priority:** ${priorityLabel}  \n**Team:** ${issue.teamName}\n`;
	}

	/** Update only the Linear-managed frontmatter keys on an existing note. */
	private async updateNoteFrontmatter(file: TFile, issue: LinearIssueStub): Promise<void> {
		const now = new Date().toISOString();
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm[LINEAR_FM.stateName] = issue.stateName;
			fm[LINEAR_FM.stateType] = issue.stateType;
			fm[LINEAR_FM.priority] = issue.priority;
			fm[LINEAR_FM.lastSynced] = now;
		});
	}

	// ── Sync: pull ──────────────────────────────────────────────────────────

	/**
	 * Pull latest status for every linked note in the vault.
	 * Safe to call on open or on interval — skips notes with no linear-id.
	 */
	async pullAll(): Promise<{ updated: number; errors: number }> {
		const linkedFiles = this.app.vault
			.getMarkdownFiles()
			.filter((f) => !!this.app.metadataCache.getFileCache(f)?.frontmatter?.[LINEAR_FM.issueId]);

		let updated = 0;
		let errors = 0;

		// Group by workspace to minimize API calls
		const byWorkspace = new Map<string, { file: TFile; issueId: string }[]>();
		for (const file of linkedFiles) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			const wsId = fm[LINEAR_FM.workspaceId] as string | undefined;
			const issueId = fm[LINEAR_FM.issueId] as string | undefined;
			if (!wsId || !issueId) continue;
			if (!byWorkspace.has(wsId)) byWorkspace.set(wsId, []);
			byWorkspace.get(wsId)!.push({ file, issueId });
		}

		for (const [wsId, items] of byWorkspace) {
			const client = this.clients.get(wsId);
			if (!client) continue;

			for (const { file, issueId } of items) {
				try {
					const issue = await client.getIssue(issueId);
					if (!issue) continue;
					const currentFm = this.app.metadataCache.getFileCache(file)?.frontmatter;
					if (currentFm?.[LINEAR_FM.stateName] !== issue.stateName) {
						await this.updateNoteFrontmatter(file, issue);
						updated++;
					}
				} catch {
					errors++;
				}
			}
		}

		return { updated, errors };
	}

	// ── Sync: push ──────────────────────────────────────────────────────────

	/**
	 * Push a status change from Obsidian → Linear.
	 *
	 * `targetStateName` is a human-readable state name (e.g. "In Progress").
	 * We look up the matching WorkflowState ID on the fly.
	 */
	async pushStatusChange(file: TFile, targetStateName: string): Promise<boolean> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return false;

		const wsId = fm[LINEAR_FM.workspaceId] as string | undefined;
		const issueId = fm[LINEAR_FM.issueId] as string | undefined;
		const teamId = fm[LINEAR_FM.teamId] as string | undefined;
		if (!wsId || !issueId || !teamId) return false;

		const client = this.clients.get(wsId);
		if (!client) return false;

		try {
			const states = await client.getWorkflowStates(teamId);
			const target = states.find(
				(s) => s.name.toLowerCase() === targetStateName.toLowerCase()
			);
			if (!target) {
				new Notice(`Linear: no state named "${targetStateName}" found in this team.`);
				return false;
			}
			await client.updateIssueState(issueId, target.id);
			// Reflect the update locally
			const now = new Date().toISOString();
			await this.app.fileManager.processFrontMatter(file, (fmw: Record<string, unknown>) => {
				fmw[LINEAR_FM.stateName] = targetStateName;
				fmw[LINEAR_FM.lastSynced] = now;
			});
			return true;
		} catch (err) {
			new Notice(`Linear push failed: ${String(err)}`);
			return false;
		}
	}

	// ── OAuth ───────────────────────────────────────────────────────────────

	/**
	 * Store an OAuth access token for a workspace and rebuild clients.
	 */
	async storeOAuthToken(workspaceId: string, accessToken: string, refreshToken?: string): Promise<void> {
		const settings = this.getSettings();
		const ws = settings.linearWorkspaces.find((w) => w.id === workspaceId);
		if (!ws) throw new Error(`Workspace "${workspaceId}" not found`);
		ws.oauthToken = accessToken;
		if (refreshToken) ws.oauthRefreshToken = refreshToken;
		await this.saveSettings();
		this.refreshClients();
	}

	// ── Convenience ─────────────────────────────────────────────────────────

	/** Returns true if `file` is a Linear-linked note. */
	isLinkedNote(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return !!(fm?.[LINEAR_FM.issueId]);
	}

	/** Returns the LinearIssueStub reconstructed from a note's frontmatter. */
	getIssueMeta(file: TFile): Partial<LinearIssueStub> | null {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm?.[LINEAR_FM.issueId]) return null;
		return {
			id: fm[LINEAR_FM.issueId] as string,
			identifier: fm[LINEAR_FM.identifier] as string,
			title: file.basename,
			url: fm[LINEAR_FM.url] as string,
			stateName: fm[LINEAR_FM.stateName] as string,
			stateType: fm[LINEAR_FM.stateType] as string,
			priority: fm[LINEAR_FM.priority] as number,
			teamId: fm[LINEAR_FM.teamId] as string,
			teamName: fm[LINEAR_FM.teamName] as string,
			workspaceId: fm[LINEAR_FM.workspaceId] as string,
		};
	}
}
