/**
 * LinearView — sidebar panel for browsing and importing Linear issues.
 *
 * Shows a workspace/team picker at the top, then a filterable issue list.
 * Click an issue to import it (or open the existing note if already imported).
 */

import { ItemView, Notice, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type { LinearManager } from "./manager";
import type { LinearIssueStub, LinearTeam } from "../types";
import type TaskToolsPlugin from "../main";

export const LINEAR_VIEW_TYPE = "task-tools-linear-view";

interface ViewState {
	workspaceId: string | null;
	teamId: string | null;
	assignedToMe: boolean;
	includeCompleted: boolean;
	searchQuery: string;
}

export class LinearView extends ItemView {
	private plugin: TaskToolsPlugin;
	private manager: LinearManager;

	private state: ViewState = {
		workspaceId: null,
		teamId: null,
		assignedToMe: false,
		includeCompleted: false,
		searchQuery: "",
	};

	private teams: LinearTeam[] = [];
	private issues: LinearIssueStub[] = [];
	private loading = false;

	constructor(leaf: WorkspaceLeaf, plugin: TaskToolsPlugin, manager: LinearManager) {
		super(leaf);
		this.plugin = plugin;
		this.manager = manager;
	}

	getViewType(): string { return LINEAR_VIEW_TYPE; }
	getDisplayText(): string { return "Linear"; }
	getIcon(): string { return "external-link"; }

	async onOpen(): Promise<void> {
		// Pick the first configured workspace by default
		const workspaces = this.manager.getConfiguredWorkspaces();
		if (workspaces.length > 0 && workspaces[0]) {
			this.state.workspaceId = workspaces[0].id;
		}
		this.render();
		if (this.state.workspaceId) await this.loadTeams();
	}

	onClose(): Promise<void> { return Promise.resolve(); }

	// ── Render ──────────────────────────────────────────────────────────────

	private render(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("linear-view");

		this.renderToolbar(root);
		this.renderFilters(root);

		const content = root.createDiv({ cls: "linear-view__content" });
		if (this.loading) {
			content.createDiv({ cls: "linear-view__loading", text: "Loading…" });
		} else if (this.issues.length === 0 && this.state.workspaceId) {
			content.createDiv({ cls: "linear-view__empty", text: "No issues found." });
		} else if (!this.state.workspaceId) {
			content.createDiv({
				cls: "linear-view__empty",
				text: "Add a Linear workspace in Settings to get started.",
			});
		} else {
			this.renderIssueList(content);
		}
	}

	private renderToolbar(root: HTMLElement): void {
		const toolbar = root.createDiv({ cls: "linear-view__toolbar" });

		// Workspace picker
		const workspaces = this.manager.getConfiguredWorkspaces();
		if (workspaces.length > 1) {
			const select = toolbar.createEl("select", { cls: "linear-view__ws-select" });
			for (const ws of workspaces) {
				const opt = select.createEl("option", { value: ws.id, text: ws.name });
				if (ws.id === this.state.workspaceId) opt.selected = true;
			}
			select.addEventListener("change", async () => {
				this.state.workspaceId = select.value;
				this.state.teamId = null;
				this.issues = [];
				this.render();
				await this.loadTeams();
			});
		} else if (workspaces.length === 1 && workspaces[0]) {
			toolbar.createSpan({ cls: "linear-view__ws-name", text: workspaces[0].name });
		}

		// Sync button
		const syncBtn = toolbar.createDiv({ cls: "linear-view__icon-btn" });
		setIcon(syncBtn, "refresh-cw");
		setTooltip(syncBtn, "Sync all linked notes", { delay: 0 });
		syncBtn.addEventListener("click", async () => {
			syncBtn.addClass("is-spinning");
			const { updated, errors } = await this.manager.pullAll();
			syncBtn.removeClass("is-spinning");
			if (errors > 0) {
				new Notice(`Linear sync: ${updated} updated, ${errors} errors.`);
			} else {
				new Notice(`Linear sync: ${updated} note${updated === 1 ? "" : "s"} updated.`);
			}
		});

		// Settings shortcut
		const settingsBtn = toolbar.createDiv({ cls: "linear-view__icon-btn" });
		setIcon(settingsBtn, "settings");
		setTooltip(settingsBtn, "Linear settings", { delay: 0 });
		settingsBtn.addEventListener("click", () => {
			// Open the plugin's settings tab
			(this.app as any).setting?.open?.();
			(this.app as any).setting?.openTabById?.("obsidian-task-tools");
		});
	}

	private renderFilters(root: HTMLElement): void {
		const bar = root.createDiv({ cls: "linear-view__filters" });

		// Team picker
		const teamSelect = bar.createEl("select", { cls: "linear-view__team-select" });
		const allOpt = teamSelect.createEl("option", { value: "", text: "All teams" });
		allOpt.selected = !this.state.teamId;
		for (const team of this.teams) {
			const opt = teamSelect.createEl("option", { value: team.id, text: team.name });
			if (team.id === this.state.teamId) opt.selected = true;
		}
		teamSelect.addEventListener("change", async () => {
			this.state.teamId = teamSelect.value || null;
			await this.loadIssues();
		});

		// Search
		const search = bar.createEl("input", {
			cls: "linear-view__search",
			type: "text",
			placeholder: "Filter issues…",
		});
		search.value = this.state.searchQuery;
		search.addEventListener("input", () => {
			this.state.searchQuery = search.value;
			this.renderIssueListOnly();
		});

		// Assigned-to-me toggle
		const meLabel = bar.createEl("label", { cls: "linear-view__toggle-label" });
		const meChk = meLabel.createEl("input", { type: "checkbox" });
		meChk.checked = this.state.assignedToMe;
		meLabel.createSpan({ text: "Mine" });
		meChk.addEventListener("change", async () => {
			this.state.assignedToMe = meChk.checked;
			await this.loadIssues();
		});

		// Include completed toggle
		const doneLabel = bar.createEl("label", { cls: "linear-view__toggle-label" });
		const doneChk = doneLabel.createEl("input", { type: "checkbox" });
		doneChk.checked = this.state.includeCompleted;
		doneLabel.createSpan({ text: "Completed" });
		doneChk.addEventListener("change", async () => {
			this.state.includeCompleted = doneChk.checked;
			await this.loadIssues();
		});
	}

	private renderIssueList(container: HTMLElement): void {
		const q = this.state.searchQuery.toLowerCase();
		const filtered = q
			? this.issues.filter(
					(i) =>
						i.title.toLowerCase().includes(q) ||
						i.identifier.toLowerCase().includes(q)
			  )
			: this.issues;

		if (filtered.length === 0) {
			container.createDiv({ cls: "linear-view__empty", text: "No matching issues." });
			return;
		}

		for (const issue of filtered) {
			this.renderIssueRow(container, issue);
		}
	}

	/** Re-render only the issue list section without touching toolbar/filters. */
	private renderIssueListOnly(): void {
		const root = this.containerEl.children[1] as HTMLElement;
		const content = root.querySelector(".linear-view__content") as HTMLElement | null;
		if (!content) return;
		content.empty();
		this.renderIssueList(content);
	}

	private renderIssueRow(container: HTMLElement, issue: LinearIssueStub): void {
		const alreadyImported = !!this.manager.findNoteForIssue(issue.id);

		const row = container.createDiv({
			cls: "linear-view__issue-row" + (alreadyImported ? " is-imported" : ""),
		});

		// Priority dot
		const priorityDot = row.createDiv({ cls: `linear-view__priority linear-view__priority--${issue.priority}` });
		setTooltip(priorityDot, ["No priority", "Urgent", "High", "Medium", "Low"][issue.priority] ?? "", { delay: 0 });

		// Status badge
		row.createSpan({
			cls: `linear-view__status linear-view__status--${issue.stateType}`,
			text: issue.stateName,
		});

		// Main text
		const text = row.createDiv({ cls: "linear-view__issue-text" });
		text.createSpan({ cls: "linear-view__identifier", text: issue.identifier });
		text.createSpan({ cls: "linear-view__title", text: issue.title });

		// Action button
		const btn = row.createDiv({ cls: "linear-view__row-btn" });
		if (alreadyImported) {
			setIcon(btn, "file-text");
			setTooltip(btn, "Open note", { delay: 0 });
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const file = this.manager.findNoteForIssue(issue.id);
				if (file) {
					const leaf = this.app.workspace.getMostRecentLeaf();
					if (leaf) await leaf.openFile(file);
				}
			});
		} else {
			setIcon(btn, "download");
			setTooltip(btn, "Import as note", { delay: 0 });
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const file = await this.manager.importIssue(issue);
				if (file) {
					row.addClass("is-imported");
					setIcon(btn, "file-text");
					setTooltip(btn, "Open note", { delay: 0 });
				}
			});
		}

		// Click row to open in Linear
		row.addEventListener("click", () => {
			window.open(issue.url, "_blank");
		});
	}

	// ── Data loading ─────────────────────────────────────────────────────────

	private async loadTeams(): Promise<void> {
		if (!this.state.workspaceId) return;
		const client = this.manager.getClient(this.state.workspaceId);
		if (!client) return;

		try {
			this.teams = await client.getTeams();
		} catch (err) {
			new Notice(`Linear: failed to load teams — ${String(err)}`);
			this.teams = [];
		}

		await this.loadIssues();
	}

	async loadIssues(): Promise<void> {
		if (!this.state.workspaceId) return;
		const client = this.manager.getClient(this.state.workspaceId);
		if (!client) return;

		this.loading = true;
		this.render();

		try {
			const { issues } = await client.getIssues({
				teamId: this.state.teamId ?? undefined,
				assignedToMe: this.state.assignedToMe,
				includeCompleted: this.state.includeCompleted,
				limit: 100,
			});
			this.issues = issues;
		} catch (err) {
			new Notice(`Linear: failed to load issues — ${String(err)}`);
			this.issues = [];
		}

		this.loading = false;
		this.render();
	}
}
