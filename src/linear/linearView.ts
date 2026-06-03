/**
 * LinearView — sidebar panel for browsing and importing Linear issues.
 *
 * Shows a workspace/team picker at the top, then a filterable issue list.
 * Click an issue to import it (or open the existing note if already imported).
 */

import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type { LinearManager } from "./manager";
import type { LinearIssueStub, LinearTeam } from "../types";
import type TaskToolsPlugin from "../main";
import { ChainSuggestModal } from "../chainSuggestModal";

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
			content.createDiv({ cls: "linear-view__empty pane-empty", text: "Loading…" });
		} else if (!this.state.workspaceId) {
			content.createDiv({
				cls: "linear-view__empty pane-empty",
				text: "Add a Linear workspace in Settings to get started.",
			});
		} else if (this.issues.length === 0) {
			content.createDiv({ cls: "linear-view__empty pane-empty", text: "No issues found." });
		} else {
			this.renderIssueList(content);
		}
	}

	private renderToolbar(root: HTMLElement): void {
		const toolbar = root.createDiv({ cls: "linear-view__toolbar nav-header" });

		// Left: workspace name or picker
		const workspaces = this.manager.getConfiguredWorkspaces();
		const left = toolbar.createDiv({ cls: "linear-view__toolbar-left" });
		if (workspaces.length > 1) {
			const select = left.createEl("select", { cls: "linear-view__ws-select dropdown" });
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
			left.createSpan({ cls: "linear-view__ws-name", text: workspaces[0].name });
		}

		// Right: icon buttons
		const buttons = toolbar.createDiv({ cls: "nav-buttons-container" });

		const syncBtn = buttons.createDiv({ cls: "clickable-icon nav-action-button linear-view__sync-btn" });
		setIcon(syncBtn, "refresh-cw");
		setTooltip(syncBtn, "Sync all linked notes", { delay: 0 });
		syncBtn.addEventListener("click", async () => {
			syncBtn.addClass("is-loading");
			const { updated, errors } = await this.manager.pullAll();
			syncBtn.removeClass("is-loading");
			new Notice(
				errors > 0
					? `Linear sync: ${updated} updated, ${errors} errors.`
					: `Linear sync: ${updated} note${updated === 1 ? "" : "s"} updated.`
			);
		});

		const settingsBtn = buttons.createDiv({ cls: "clickable-icon nav-action-button" });
		setIcon(settingsBtn, "settings");
		setTooltip(settingsBtn, "Linear settings", { delay: 0 });
		settingsBtn.addEventListener("click", () => {
			(this.app as any).setting?.open?.();
			(this.app as any).setting?.openTabById?.("obsidian-task-tools");
		});
	}

	private renderFilters(root: HTMLElement): void {
		const bar = root.createDiv({ cls: "linear-view__filters" });

		// Row 1: search + team select
		const row1 = bar.createDiv({ cls: "linear-view__filter-row" });

		const search = row1.createEl("input", {
			cls: "linear-view__search",
			type: "search",
			placeholder: "Filter issues…",
		});
		search.value = this.state.searchQuery;
		search.addEventListener("input", () => {
			this.state.searchQuery = search.value;
			this.renderIssueListOnly();
		});

		// Row 2: team picker + toggles
		const row2 = bar.createDiv({ cls: "linear-view__filter-row linear-view__filter-row--meta" });

		const teamSelect = row2.createEl("select", { cls: "linear-view__team-select dropdown" });
		teamSelect.createEl("option", { value: "", text: "All teams" }).selected = !this.state.teamId;
		for (const team of this.teams) {
			const opt = teamSelect.createEl("option", { value: team.id, text: team.name });
			if (team.id === this.state.teamId) opt.selected = true;
		}
		teamSelect.addEventListener("change", async () => {
			this.state.teamId = teamSelect.value || null;
			await this.loadIssues();
		});

		const toggles = row2.createDiv({ cls: "linear-view__toggles" });

		const makeToggle = (label: string, checked: boolean, onChange: (v: boolean) => void) => {
			const btn = toggles.createEl("button", {
				cls: "linear-view__filter-chip" + (checked ? " is-active" : ""),
				text: label,
			});
			btn.addEventListener("click", () => {
				const next = !btn.hasClass("is-active");
				btn.toggleClass("is-active", next);
				onChange(next);
			});
		};

		makeToggle("Mine", this.state.assignedToMe, async (v) => {
			this.state.assignedToMe = v;
			await this.loadIssues();
		});
		makeToggle("Completed", this.state.includeCompleted, async (v) => {
			this.state.includeCompleted = v;
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
		const priorityLabels = ["No priority", "Urgent", "High", "Medium", "Low"];

		const row = container.createDiv({
			cls: "linear-view__issue-row" + (alreadyImported ? " is-imported" : ""),
		});

		// Left: priority dot
		const dot = row.createDiv({ cls: `linear-view__priority-dot linear-view__priority-dot--${issue.priority}` });
		setTooltip(dot, priorityLabels[issue.priority] ?? "Unknown priority", { delay: 0 });

		// Center: text block
		const body = row.createDiv({ cls: "linear-view__row-body" });

		const titleLine = body.createDiv({ cls: "linear-view__row-title" });
		titleLine.createSpan({ cls: "linear-view__identifier", text: issue.identifier });
		titleLine.createSpan({ cls: "linear-view__title", text: issue.title });

		body.createDiv({
			cls: `linear-view__status-badge linear-view__status-badge--${issue.stateType}`,
			text: issue.stateName,
		});

		// Right: action buttons (visible on hover)
		const actions = row.createDiv({ cls: "linear-view__row-actions" });

		const importBtn = actions.createDiv({ cls: "clickable-icon linear-view__action-btn" });
		if (alreadyImported) {
			setIcon(importBtn, "file-text");
			setTooltip(importBtn, "Open note", { delay: 0 });
			importBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const file = this.manager.findNoteForIssue(issue.id);
				if (file) {
					const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
					if (leaf) await leaf.openFile(file);
				}
			});
		} else {
			setIcon(importBtn, "download");
			setTooltip(importBtn, "Import as note", { delay: 0 });
			importBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const file = await this.manager.importIssue(issue);
				if (file) {
					row.addClass("is-imported");
					setIcon(importBtn, "file-text");
					setTooltip(importBtn, "Open note", { delay: 0 });
				}
			});
		}

		const dotsBtn = actions.createDiv({ cls: "clickable-icon linear-view__action-btn" });
		setIcon(dotsBtn, "more-horizontal");
		setTooltip(dotsBtn, "More actions", { delay: 0 });
		dotsBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.showIssueMenu(e, issue, row, importBtn);
		});

		row.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.showIssueMenu(e, issue, row, importBtn);
		});

		row.addEventListener("click", () => window.open(issue.url, "_blank"));
	}

	private showIssueMenu(
		e: MouseEvent,
		issue: LinearIssueStub,
		row: HTMLElement,
		importBtn: HTMLElement
	): void {
		const chains = this.plugin.settings.chains;
		const menu = new Menu();

		// ── Add to chain ──────────────────────────────────────────────────────
		if (chains.length === 0) {
			menu.addItem((item) =>
				item
					.setTitle("No chains configured")
					.setDisabled(true)
			);
		} else if (chains.length === 1 && chains[0]) {
			const chain = chains[0];
			menu.addItem((item) =>
				item
					.setTitle(`Add to "${chain.name}"`)
					.setIcon("link")
					.onClick(async () => {
						await this.importAndAddToChain(issue, chain.name, row, importBtn);
					})
			);
		} else {
			menu.addItem((item) =>
				item
					.setTitle("Add to chain…")
					.setIcon("link")
					.onClick(() => {
						new ChainSuggestModal(this.app, chains, async (chain) => {
							await this.importAndAddToChain(issue, chain.name, row, importBtn);
						}).open();
					})
			);
		}

		menu.addSeparator();

		// ── Standard actions ──────────────────────────────────────────────────
		const alreadyImported = !!this.manager.findNoteForIssue(issue.id);
		if (alreadyImported) {
			menu.addItem((item) =>
				item
					.setTitle("Open note")
					.setIcon("file-text")
					.onClick(async () => {
						const file = this.manager.findNoteForIssue(issue.id);
						if (file) {
							const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
							if (leaf) await leaf.openFile(file);
						}
					})
			);
		} else {
			menu.addItem((item) =>
				item
					.setTitle("Import as note")
					.setIcon("download")
					.onClick(async () => {
						const file = await this.manager.importIssue(issue);
						if (file) {
							row.addClass("is-imported");
							setIcon(importBtn, "file-text");
							setTooltip(importBtn, "Open note", { delay: 0 });
						}
					})
			);
		}

		menu.addItem((item) =>
			item
				.setTitle("Open in Linear")
				.setIcon("external-link")
				.onClick(() => window.open(issue.url, "_blank"))
		);

		menu.showAtMouseEvent(e);
	}

	/**
	 * Import the issue (or reuse existing note) then add it to the named chain.
	 */
	private async importAndAddToChain(
		issue: LinearIssueStub,
		chainName: string,
		row: HTMLElement,
		importBtn: HTMLElement
	): Promise<void> {
		// Import first (no-op if already imported)
		const file = await this.manager.importIssue(issue);
		if (!file) return;

		// Update row state
		row.addClass("is-imported");
		setIcon(importBtn, "file-text");
		setTooltip(importBtn, "Open note", { delay: 0 });

		// Find the chain definition and add the file
		const chain = this.plugin.settings.chains.find((c) => c.name === chainName);
		if (!chain) {
			new Notice(`Chain "${chainName}" not found.`);
			return;
		}

		await this.plugin.addFileToChain(file, chain);
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
		// Full render only for the initial loading state (toolbar/filters not yet built)
		const root = this.containerEl.children[1] as HTMLElement;
		const existingContent = root.querySelector(".linear-view__content") as HTMLElement | null;
		if (existingContent) {
			existingContent.empty();
			existingContent.createDiv({ cls: "linear-view__empty pane-empty", text: "Loading…" });
		} else {
			this.render();
		}

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
		// Partial redraw — preserves toolbar/filter DOM and focus state
		this.renderIssueListOnly();
	}
}
