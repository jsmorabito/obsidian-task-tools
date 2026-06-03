import { App, MarkdownView, Menu, Modal, Notice, Plugin, Setting, TFile, setIcon, setTooltip, ButtonComponent } from "obsidian";

/** Frontmatter key written when a task is marked done. */
const COMPLETED_DATE_KEY = "completedDate";
import {
	DEFAULT_SETTINGS,
	TaskToolsSettings,
	TaskToolsSettingTab,
	derivedChainKeys,
	slugifyChainName,
} from "./settings";
import { CHAIN_VIEW_TYPE, ChainView, QuickAddFileModal } from "./chainView";
import { NewTaskModal } from "./newTaskModal";
import { ChainSuggestModal } from "./chainSuggestModal";
import { ChainInstanceSuggestModal } from "./chainInstanceSuggestModal";
import type { ChainDefinition, ChainItem, FrontmatterRule } from "./types";
import { LinearManager } from "./linear/manager";
import { LINEAR_VIEW_TYPE, LinearView } from "./linear/linearView";

/** Simple modal that prompts for a filename and creates a blank .md file. */
class NewBlankFileModal extends Modal {
	private plugin: TaskToolsPlugin;
	private chain: ChainDefinition;
	private name = "";

	constructor(plugin: TaskToolsPlugin, chain: ChainDefinition) {
		super(plugin.app);
		this.plugin = plugin;
		this.chain = chain;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "New file" });

		new Setting(contentEl)
			.setName("File name")
			.addText((text) => {
				text.setPlaceholder("My new file").onChange((v) => { this.name = v.trim(); });
				// Submit on Enter
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") { e.preventDefault(); void this.submit(); }
				});
				setTimeout(() => text.inputEl.focus(), 0);
			});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Create").setCta().onClick(() => void this.submit())
			);
	}

	onClose(): void { this.contentEl.empty(); }

	private async submit(): Promise<void> {
		if (!this.name) { new Notice("File name is required."); return; }
		const folder = this.chain.itemFolder ?? this.plugin.settings.taskFolder ?? "";
		const dir = folder ? `${folder}/` : "";
		const path = `${dir}${this.name}.md`;
		try {
			const file = await this.plugin.app.vault.create(path, "");
			await this.plugin.addFileToChain(file, this.chain);
			this.close();
		} catch (err) {
			new Notice(`Could not create file: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

export default class TaskToolsPlugin extends Plugin {
	settings: TaskToolsSettings;
	linearManager: LinearManager | null = null;
	private chainStatusBarItem: HTMLElement;
	private statusBarObserver: ResizeObserver | null = null;
	private linearSyncIntervalId: number | null = null;
	/** The file currently open in the main editor, kept in sync via workspace events. */
	private mainEditorFile: TFile | null = null;

	/**
	 * Index: key = "${idKey}::${chainId}", value = Set of file paths.
	 * Lets buildChain and findCurrentTask avoid full vault scans.
	 */
	private chainIndex: Map<string, Set<string>> = new Map();

	async onload() {
		await this.loadSettings();

		// ── Linear setup ────────────────────────────────────────────────────
		this.linearManager = new LinearManager(
			this.app,
			() => this.settings,
			() => this.saveSettings()
		);
		this.linearManager.refreshClients();

		// Register Linear sidebar view
		this.registerView(
			LINEAR_VIEW_TYPE,
			(leaf) => new LinearView(leaf, this, this.linearManager!)
		);

		// Build index once the workspace and metadata cache are fully ready,
		// then re-render any chain views that opened before the index was populated.
		this.app.workspace.onLayoutReady(() => {
			const init = () => {
				this.rebuildIndex();
				this.app.workspace.getLeavesOfType(CHAIN_VIEW_TYPE).forEach((leaf) => {
					try { (leaf.view as ChainView).render(); } catch { /* view not ready yet */ }
				});
				this.renderChainBreadcrumb();
			};

			// metadataCache fires "resolved" when all files are indexed.
			// If it's already resolved, run immediately; otherwise wait for it.
			this.registerEvent(this.app.metadataCache.on("resolved", init));
			// Belt-and-suspenders: also call now in case "resolved" already fired.
			init();
		});

		// Register chain view
		this.registerView(
			CHAIN_VIEW_TYPE,
			(leaf) => new ChainView(leaf, this)
		);

		// Ribbon icon
		this.addRibbonIcon("link", "Open chain view", () => {
			void this.openChainView();
		});

		// Chain breadcrumb — standalone div to the left of the status bar
		this.chainStatusBarItem = document.body.createDiv({ cls: "chain-status-bar-item" });
		this.chainStatusBarItem.style.cursor = "pointer";
		setTooltip(this.chainStatusBarItem, "Click to switch chain", { delay: 0, placement: "top" });
		this.chainStatusBarItem.addEventListener("click", () => {
			this.openStatusBarChainPicker();
		});
		this.register(() => this.chainStatusBarItem.remove());
		this.renderChainBreadcrumb();

		// Keep chain bar snapped to the left of the status bar
		this.app.workspace.onLayoutReady(() => this.setupStatusBarObserver());
		const onResize = () => this.positionChainBar();
		window.addEventListener("resize", onResize);
		this.register(() => window.removeEventListener("resize", onResize));

		// Incremental index updates
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.updateIndexForFile(file);
				this.renderChainBreadcrumb();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) {
					this.removeFileFromIndex(oldPath);
					this.updateIndexForFile(file);
					this.renderChainBreadcrumb();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) {
					this.removeFileFromIndex(file.path);
					this.renderChainBreadcrumb();
				}
			})
		);

		// file-open: captures new file directly from the event — no leaf query needed.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				this.mainEditorFile = file ?? null;
				this.renderChainBreadcrumb();
			})
		);
		// active-leaf-change: use the event's leaf parameter directly.
		// Only update mainEditorFile when a real markdown leaf became active.
		// When a sidebar panel steals focus, leaf is not a MarkdownView so we
		// leave mainEditorFile unchanged and just re-render with the existing value.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof MarkdownView) {
					this.mainEditorFile = leaf.view.file;
				}
				this.renderChainBreadcrumb();
			})
		);

		this.addSettingTab(new TaskToolsSettingTab(this.app, this));

		// ── Linear sync on open ──────────────────────────────────────────────
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.linearSyncOnOpen && this.linearManager?.getConfiguredWorkspaces().length) {
				void this.linearManager.pullAll().then(({ updated }) => {
					if (updated > 0) new Notice(`Linear: pulled ${updated} update${updated === 1 ? "" : "s"}.`);
				});
			}
			this.rescheduleLinearSync();
		});

		// Command: open Linear panel
		this.addCommand({
			id: "open-linear-view",
			name: "Open Linear panel",
			callback: () => { void this.openLinearView(); },
		});

		// Command: sync Linear (manual pull)
		this.addCommand({
			id: "linear-sync",
			name: "Linear: sync all linked notes",
			callback: async () => {
				if (!this.linearManager?.getConfiguredWorkspaces().length) {
					new Notice("No Linear workspaces configured.");
					return;
				}
				const { updated, errors } = await this.linearManager.pullAll();
				const msg = errors > 0
					? `Linear sync: ${updated} updated, ${errors} errors.`
					: `Linear sync complete — ${updated} note${updated === 1 ? "" : "s"} updated.`;
				new Notice(msg);
			},
		});

		// Command: import active-file issue to Linear (push new issue)
		this.addCommand({
			id: "linear-push-issue",
			name: "Linear: push status of active note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.linearManager?.isLinkedNote(file)) return false;
				if (!checking) {
					// Prompt for target state name via a simple Notice pattern
					new LinearPushStateModal(this.app, async (stateName) => {
						const ok = await this.linearManager!.pushStatusChange(file, stateName);
						if (ok) new Notice(`Pushed status "${stateName}" to Linear.`);
					}).open();
				}
				return true;
			},
		});

		// Ribbon icon for Linear panel
		this.addRibbonIcon("external-link", "Open Linear panel", () => {
			void this.openLinearView();
		});

		// Command: new task (uses global task settings)
		this.addCommand({
			id: "new-task",
			name: "New task",
			callback: () => {
				new NewTaskModal(this.app, this).open();
			},
		});

		// Command: new item for a specific chain (uses that chain's creation config)
		this.addCommand({
			id: "new-chain-item",
			name: "New item for chain…",
			callback: () => {
				const chains = this.settings.chains.filter(
					(c) =>
						c.itemFolder !== undefined ||
						c.itemFrontmatterKey !== undefined ||
						c.itemTemplatePath !== undefined
				);
				if (chains.length === 0) {
					new Notice(
						"No chains have item creation config. Add an item folder or frontmatter key to a chain schema in Settings."
					);
					return;
				}
				if (chains.length === 1 && chains[0]) {
					new NewTaskModal(this.app, this, chains[0]).open();
				} else {
					new ChainSuggestModal(this.app, chains, (chain) => {
						new NewTaskModal(this.app, this, chain).open();
					}).open();
				}
			},
		});

		// Command: open chain view
		this.addCommand({
			id: "open-chain-view",
			name: "Open chain view",
			callback: () => { void this.openChainView(); },
		});

		// Command: set active file as current task
		this.addCommand({
			id: "set-current-task",
			name: "Set as current task",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const chains = this.getChainsForFile(file);
				if (chains.length === 0) return false;
				if (!checking) {
					if (chains.length === 1 && chains[0]) {
						void this.setCurrentTask(file, chains[0]);
					} else {
						new ChainSuggestModal(this.app, chains, (chain) => {
							void this.setCurrentTask(file, chain);
						}).open();
					}
				}
				return true;
			},
		});

		// Command: advance chain
		this.addCommand({
			id: "advance-chain",
			name: "Advance chain",
			checkCallback: (checking: boolean) => {
				const chain = this.getStatusBarChain();
				if (!chain) return false;
				const current = this.findCurrentTask(chain);
				if (!current) return false;
				if (!checking) void this.advanceChain(chain, current);
				return true;
			},
		});

		// Command: check if active file is a task file
		this.addCommand({
			id: "check-is-task-file",
			name: "Check if current file is a task file",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) {
					const isTask = this.isTaskFile(file);
					new Notice(
						isTask
							? `"${file.basename}" is a task file.`
							: `"${file.basename}" is not a task file.`
					);
				}
				return true;
			},
		});

		// Command: reconcile chain statuses (fix stale frontmatter)
		this.addCommand({
			id: "reconcile-chain-statuses",
			name: "Reconcile chain statuses",
			callback: async () => {
				for (const chain of this.settings.chains) {
					await this.reconcileChain(chain);
				}
				new Notice("Chain statuses reconciled.");
			},
		});

		// Command: toggle chain bar
		this.addCommand({
			id: "toggle-chain-bar",
			name: "Toggle chain bar",
			callback: async () => {
				this.settings.chainBarVisible = !this.settings.chainBarVisible;
				await this.saveSettings();
				this.renderChainBreadcrumb();
			},
		});

		// Command: auto-populate chains
		this.addCommand({
			id: "auto-populate-chains",
			name: "Auto-populate chains…",
			callback: () => {
				const eligible = this.settings.chains.filter((c) => c.autoPopulateEnabled);
				if (eligible.length === 0) {
					new Notice("No chains have auto-populate enabled. Configure it in Settings.");
					return;
				}
				if (eligible.length === 1 && eligible[0]) {
					void this.autoPopulateChain(eligible[0]).then((n) => {
						new Notice(`Auto-populated ${n} file${n === 1 ? "" : "s"} into "${eligible[0]!.name}".`);
					});
				} else {
					new ChainSuggestModal(this.app, eligible, (chain) => {
						void this.autoPopulateChain(chain).then((n) => {
							new Notice(`Auto-populated ${n} file${n === 1 ? "" : "s"} into "${chain.name}".`);
						});
					}).open();
				}
			},
		});

		// Command: add active file to a chain
		this.addCommand({
			id: "add-to-chain",
			name: "Add to chain…",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (this.settings.chains.length === 0) return false;
				if (!checking) {
					const pickChain = (chain: ChainDefinition) => {
						void this.addFileToChain(file, chain);
					};

					if (this.settings.chains.length === 1 && this.settings.chains[0]) {
						pickChain(this.settings.chains[0]);
					} else {
						new ChainSuggestModal(this.app, this.settings.chains, pickChain).open();
					}
				}
				return true;
			},
		});

		// File menu: add to chain
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;
				if (this.settings.chains.length === 0) return;
				menu.addItem((item) => {
					item
						.setTitle("Add to chain…")
						.setIcon("link")
						.onClick(() => {
							const pickChain = (chain: ChainDefinition) => {
								void this.addFileToChain(file, chain);
							};
							if (this.settings.chains.length === 1 && this.settings.chains[0]) {
								pickChain(this.settings.chains[0]);
							} else {
								new ChainSuggestModal(this.app, this.settings.chains, pickChain).open();
							}
						});
				});
			})
		);

		// Command: remove active file from chain
		this.addCommand({
			id: "remove-from-chain",
			name: "Remove active file from chain…",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const chains = this.getChainsForFile(file);
				if (chains.length === 0) return false;
				if (!checking) {
					if (chains.length === 1 && chains[0]) {
						void this.removeFileFromChain(file, chains[0]);
					} else {
						new ChainMultiSelectModal(this.app, chains, async (selected) => {
							for (const chain of selected) {
								await this.removeFileFromChain(file, chain);
							}
						}).open();
					}
				}
				return true;
			},
		});
	}

	onunload() {
		if (this.linearSyncIntervalId !== null) {
			window.clearInterval(this.linearSyncIntervalId);
		}
	}

	// ── Linear public methods ───────────────────────────────────────────────

	async openLinearView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(LINEAR_VIEW_TYPE);
		const firstExisting = existing[0];
		if (firstExisting) {
			this.app.workspace.revealLeaf(firstExisting);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf !== null) {
			await leaf.setViewState({ type: LINEAR_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}

	/** Start or restart the Linear polling interval based on current settings. */
	rescheduleLinearSync(): void {
		if (this.linearSyncIntervalId !== null) {
			window.clearInterval(this.linearSyncIntervalId);
			this.linearSyncIntervalId = null;
		}
		const mins = this.settings.linearSyncIntervalMinutes;
		if (mins > 0 && this.linearManager) {
			this.linearSyncIntervalId = window.setInterval(async () => {
				const { updated } = await this.linearManager!.pullAll();
				if (updated > 0) new Notice(`Linear: pulled ${updated} update${updated === 1 ? "" : "s"}.`);
			}, mins * 60 * 1000);
		}
	}

	/**
	 * Start the OAuth flow for a workspace.
	 * Opens Linear's authorize URL in the default browser.
	 * The user pastes the code back — a full callback server is out of scope
	 * for a desktop plugin, so we use a manual code-paste flow for now.
	 */
	startLinearOAuth(workspaceId: string): void {
		new LinearOAuthModal(this.app, workspaceId, async (token) => {
			await this.linearManager?.storeOAuthToken(workspaceId, token);
			new Notice("Linear workspace connected.");
			// Refresh settings UI
			(this.app as any).setting?.open?.();
			(this.app as any).setting?.openTabById?.("obsidian-task-tools");
		}).open();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<TaskToolsSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ── Index management ───────────────────────────────────────────────────

	private indexKey(idKey: string, chainId: string): string {
		return `${idKey}::${chainId}`;
	}

	/** Build the index from scratch by iterating all markdown files once. */
	private rebuildIndex(): void {
		this.chainIndex.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			this.updateIndexForFile(file);
		}
	}

	/** Add or update a single file's entries in the index. */
	private updateIndexForFile(file: TFile): void {
		// Remove stale entries for this file first
		this.removeFileFromIndex(file.path);

		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return;

		for (const chain of this.settings.chains) {
			const chainId = fm[chain.idKey];
			if (chainId == null) continue;
			const key = this.indexKey(chain.idKey, String(chainId));
			if (!this.chainIndex.has(key)) this.chainIndex.set(key, new Set());
			this.chainIndex.get(key)!.add(file.path);
		}
	}

	/** Remove all index entries that reference the given file path. */
	private removeFileFromIndex(filePath: string): void {
		for (const set of this.chainIndex.values()) {
			set.delete(filePath);
		}
	}

	/** Resolve file paths from the index to TFile objects, skipping missing files. */
	private resolveFiles(paths: Set<string>): TFile[] {
		const files: TFile[] = [];
		for (const path of paths) {
			const f = this.app.vault.getFileByPath(path);
			if (f) files.push(f);
		}
		return files;
	}

	// ── Public API ─────────────────────────────────────────────────────────

	/**
	 * Returns all distinct chain instances (chainId + file count) for a schema.
	 * Used to populate the "Add to chain" picker.
	 */
	getChainInstances(chain: ChainDefinition): { chainId: string; fileCount: number }[] {
		const prefix = `${chain.idKey}::`;
		const result: { chainId: string; fileCount: number }[] = [];
		for (const [key, paths] of this.chainIndex) {
			if (!key.startsWith(prefix)) continue;
			const chainId = key.slice(prefix.length);
			result.push({ chainId, fileCount: paths.size });
		}
		result.sort((a, b) => a.chainId.localeCompare(b.chainId));
		return result;
	}

	/**
	 * Opens a small menu near the triggering element offering four ways to add
	 * items to the given chain.
	 */
	openAddToChainMenu(e: MouseEvent, chain: ChainDefinition): void {
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("Add current file to chain")
				.setIcon("file-plus")
				.onClick(() => {
					const file = this.app.workspace.getActiveFile();
					if (!file) { new Notice("No active file."); return; }
					void this.addFileToChain(file, chain);
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("Add file to chain")
				.setIcon("folder-open")
				.onClick(() => {
					new QuickAddFileModal(this, chain).open();
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("Add new file to chain")
				.setIcon("file")
				.onClick(() => {
					new NewBlankFileModal(this, chain).open();
				})
		);

		menu.addItem((item) =>
			item
				.setTitle("Add new file with template to chain")
				.setIcon("layout-template")
				.onClick(() => {
					new NewTaskModal(this.app, this, chain).open();
				})
		);

		menu.showAtMouseEvent(e);
	}

	/**
	 * Adds `file` to `chain` by writing the idKey and positionKey frontmatter.
	 * Reuses the existing chainId value from other files in the chain, or derives
	 * one from the chain name if the chain has no files yet.
	 * Position is set to max(existing positions) + 1.
	 */
	async addFileToChain(file: TFile, chain: ChainDefinition, silent = false): Promise<void> {
		// Find the existing chainId from already-indexed files, falling back to chain name
		const instances = this.getChainInstances(chain);
		const chainId = instances[0]?.chainId ?? chain.name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");

		const peers = this.resolveFiles(
			this.chainIndex.get(this.indexKey(chain.idKey, chainId)) ?? new Set()
		);

		// Compute next position
		let maxPos = 0;
		for (const peer of peers) {
			const pos = Number(
				this.app.metadataCache.getFileCache(peer)?.frontmatter?.[chain.positionKey]
			);
			if (!isNaN(pos) && pos > maxPos) maxPos = pos;
		}
		const nextPos = maxPos + 1;

		// Check before writing — metadataCache won't reflect our write until the
		// changed event fires, so reading it after processFrontMatter would race.
		const shouldSetCurrent = !this.findCurrentTask(chain);

		await this.app.fileManager.processFrontMatter(file, (front) => {
			front[chain.idKey] = chainId;
			front[chain.positionKey] = nextPos;
			if (shouldSetCurrent) {
				front[chain.statusKey] = chain.currentStatusValue;
			}
		});

		if (!silent) new Notice(`Added "${file.basename}" to chain "${chainId}" at position ${nextPos}.`);
	}

	/**
	 * Removes `file` from `chain` by deleting chain-related frontmatter keys.
	 * If the file was the current task, promotes the next sibling before removal.
	 */
	async removeFileFromChain(file: TFile, chain: ChainDefinition): Promise<void> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || fm[chain.idKey] == null) {
			new Notice(`"${file.basename}" is not in chain "${chain.name}".`);
			return;
		}

		const wasCurrent = fm[chain.statusKey] === chain.currentStatusValue;

		if (wasCurrent) {
			// Promote the next sibling before we strip the frontmatter
			const items = this.buildChain(file, chain);
			const currentItem = items.find((i) => i.file.path === file.path);
			const next = currentItem
				? items.filter((i) => i.order > currentItem.order).sort((a, b) => a.order - b.order)[0]
				: undefined;
			if (next) {
				await this.setCurrentTask(next.file, chain);
			}
		}

		await this.app.fileManager.processFrontMatter(file, (front) => {
			delete front[chain.idKey];
			delete front[chain.positionKey];
			if (wasCurrent) delete front[chain.statusKey];
		});

		new Notice(`Removed "${file.basename}" from chain "${chain.name}".`);
	}

	/** Returns all files in a given chain via the index. */
	getPeerFiles(chain: ChainDefinition, chainId: string): TFile[] {
		return this.resolveFiles(
			this.chainIndex.get(this.indexKey(chain.idKey, chainId)) ?? new Set()
		);
	}

	getChainsForFile(file: TFile): ChainDefinition[] {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return [];
		return this.settings.chains.filter((chain) => fm[chain.idKey] != null);
	}

	async setCurrentTask(file: TFile, chain: ChainDefinition): Promise<void> {
		const chainId = this.app.metadataCache.getFileCache(file)?.frontmatter?.[chain.idKey];
		if (!chainId) return;

		const siblings = this.resolveFiles(
			this.chainIndex.get(this.indexKey(chain.idKey, String(chainId))) ?? new Set()
		);

		for (const f of siblings) {
			if (f.path === file.path) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (fm?.[chain.statusKey] === chain.currentStatusValue) {
				await this.app.fileManager.processFrontMatter(f, (front) => {
					delete front[chain.statusKey];
				});
			}
		}

		await this.app.fileManager.processFrontMatter(file, (front) => {
			front[chain.statusKey] = chain.currentStatusValue;
			// clear ready flag if it was set
		});
	}

	/**
	 * Reconciles chain frontmatter so position is the source of truth.
	 * Items before the current task get completedStatusValue; items after
	 * lose any stale completedStatusValue (ready stays intact).
	 */
	async reconcileChain(chain: ChainDefinition): Promise<void> {
		const currentTask = this.findCurrentTask(chain);
		if (!currentTask) return;
		const items = this.buildChain(currentTask, chain);
		const readyVal = chain.readyStatusValue ?? "ready";
		for (const item of items) {
			await this.app.fileManager.processFrontMatter(item.file, (front) => {
				if (item.role === "previous") {
					front[chain.statusKey] = chain.completedStatusValue;
				} else if (item.role === "current") {
					front[chain.statusKey] = chain.currentStatusValue;
				} else {
					// next/ready: clear any stale done status
					if (front[chain.statusKey] === chain.completedStatusValue) {
						delete front[chain.statusKey];
					}
				}
			});
		}
	}

	/**
	 * Sets an item's status and repositions it in the chain if needed.
	 * - "done"  → moves before the current item
	 * - "todo" or "ready" → moves to just after the current item (if currently before it)
	 */
	async setItemStatus(
		file: TFile,
		chain: ChainDefinition,
		newStatus: "done" | "todo" | "ready"
	): Promise<void> {
		const currentTask = this.findCurrentTask(chain);
		if (!currentTask) return;

		const items = this.buildChain(currentTask, chain);
		const currentItem = items.find((i) => i.role === "current");
		const targetItem = items.find((i) => i.file.path === file.path);
		if (!currentItem || !targetItem) return;

		const needsReposition =
			(newStatus === "done" && targetItem.role !== "previous") ||
			((newStatus === "todo" || newStatus === "ready") && targetItem.role === "previous");

		if (!needsReposition) {
			// Just update the status in place
			await this.app.fileManager.processFrontMatter(file, (front) => {
				if (newStatus === "done") {
					front[chain.statusKey] = chain.completedStatusValue;
					front[COMPLETED_DATE_KEY] = (this.app as any).moment().format("YYYY-MM-DD");
				} else if (newStatus === "ready") {
					front[chain.statusKey] = chain.readyStatusValue ?? "ready";
					delete front[COMPLETED_DATE_KEY];
				} else {
					delete front[chain.statusKey];
					delete front[COMPLETED_DATE_KEY];
				}
			});
			return;
		}

		// Reorder: remove item from current position, reinsert at target boundary
		const without = items.filter((i) => i.file.path !== file.path);
		const currentIdx = without.findIndex((i) => i.role === "current");

		let insertAt: number;
		if (newStatus === "done") {
			// Insert just before current
			insertAt = currentIdx;
		} else {
			// Insert just after current
			insertAt = currentIdx + 1;
		}

		without.splice(insertAt, 0, targetItem);

		// Write new positions and statuses
		const readyVal = chain.readyStatusValue ?? "ready";
		for (let i = 0; i < without.length; i++) {
			const itm = without[i]!;
			const isTarget = itm.file.path === file.path;
			await this.app.fileManager.processFrontMatter(itm.file, (front) => {
				front[chain.positionKey] = i + 1;
				if (itm.role === "current") {
					front[chain.statusKey] = chain.currentStatusValue;
				} else if (isTarget) {
					if (newStatus === "done") {
						front[chain.statusKey] = chain.completedStatusValue;
						front[COMPLETED_DATE_KEY] = (this.app as any).moment().format("YYYY-MM-DD");
					} else if (newStatus === "ready") {
						front[chain.statusKey] = readyVal;
						delete front[COMPLETED_DATE_KEY];
					} else {
						delete front[chain.statusKey];
						delete front[COMPLETED_DATE_KEY];
					}
				}
				// Leave other items' statuses as-is; positions are updated above
			});
		}
	}

	async toggleReadyTask(file: TFile, chain: ChainDefinition): Promise<void> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const readyValue = chain.readyStatusValue ?? "ready";
		const isAlreadyReady = fm?.[chain.statusKey] === readyValue;
		await this.app.fileManager.processFrontMatter(file, (front) => {
			if (isAlreadyReady) {
				delete front[chain.statusKey];
			} else {
				front[chain.statusKey] = readyValue;
			}
		});
	}

	isTaskFile(file: TFile): boolean {
		const { taskFrontmatterKey, taskFrontmatterValue } = this.settings;
		if (!taskFrontmatterKey) return false;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm || !(taskFrontmatterKey in fm)) return false;
		if (taskFrontmatterValue) {
			return String(fm[taskFrontmatterKey]) === taskFrontmatterValue;
		}
		return true;
	}

	findCurrentTask(chain: ChainDefinition): TFile | undefined {
		// Scan only files that belong to any chain with this schema's idKey
		for (const [key, paths] of this.chainIndex) {
			if (!key.startsWith(`${chain.idKey}::`)) continue;
			for (const f of this.resolveFiles(paths)) {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
				if (fm?.[chain.statusKey] === chain.currentStatusValue) return f;
			}
		}
		return undefined;
	}

	buildChain(currentFile: TFile, chain: ChainDefinition): ChainItem[] {
		const currentCache = this.app.metadataCache.getFileCache(currentFile);
		const chainId = currentCache?.frontmatter?.[chain.idKey];
		const currentOrder = Number(currentCache?.frontmatter?.[chain.positionKey]);

		if (!chainId) return [];

		const peers = this.resolveFiles(
			this.chainIndex.get(this.indexKey(chain.idKey, String(chainId))) ?? new Set()
		);

		const items: ChainItem[] = [];

		for (const file of peers) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;

			const fileOrder = Number(fm[chain.positionKey]);
			if (isNaN(fileOrder)) continue;

			const isCurrent = fm[chain.statusKey] === chain.currentStatusValue;
			const isReady = fm[chain.statusKey] === (chain.readyStatusValue ?? "ready");

			let role: "previous" | "current" | "ready" | "next";
			if (isCurrent) {
				role = "current";
			} else if (fileOrder < currentOrder) {
				role = "previous";
			} else if (isReady) {
				role = "ready";
			} else {
				role = "next";
			}

			items.push({ file, order: fileOrder, role });
		}

		items.sort((a, b) => a.order - b.order);
		return items;
	}

	/** Returns the chain currently shown in the status bar, if any. */
	getStatusBarChain(): ChainDefinition | undefined {
		const { statusBarChainIdKey } = this.settings;
		const preferred = statusBarChainIdKey
			? this.settings.chains.find((c) => c.idKey === statusBarChainIdKey)
			: undefined;
		return (
			(preferred && this.findCurrentTask(preferred) ? preferred : undefined) ??
			this.settings.chains.find((c) => this.findCurrentTask(c) !== undefined)
		);
	}

	/**
	 * Advance the status-bar chain:
	 * 1. Mark the current task as completedStatusValue in every chain it belongs to.
	 * 2. Set the next task in `chain` as current and open it.
	 */
	async advanceChain(chain: ChainDefinition, currentTask: TFile): Promise<void> {
		// Step 1 — snapshot chain order BEFORE writing any frontmatter changes
		const items = this.buildChain(currentTask, chain);
		const currentItem = items.find((i) => i.file.path === currentTask.path);
		if (!currentItem) return;

		const next = items
			.filter((i) => i.order > currentItem.order)
			.sort((a, b) => a.order - b.order)[0];

		if (!next) {
			new Notice(`"${chain.name}" chain complete — no next task.`);
			return;
		}

		// Step 2 — mark done in all chains this file belongs to (after snapshot)
		const allChains = this.getChainsForFile(currentTask);
		for (const c of allChains) {
			await this.app.fileManager.processFrontMatter(currentTask, (front) => {
				front[c.statusKey] = c.completedStatusValue;
				front[COMPLETED_DATE_KEY] = (this.app as any).moment().format("YYYY-MM-DD");
			});
		}

		// Step 2b — if this chain has a completion target, append the completed task there
		if (chain.completionChainIdKey) {
			const targetChain = this.settings.chains.find(
				(c) => c.idKey === chain.completionChainIdKey
			);
			if (targetChain) {
				await this.addFileToChain(currentTask, targetChain);
			}
		}

		// Step 3 — set next as current and open it
		await this.setCurrentTask(next.file, chain);
		const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
		if (leaf) await leaf.openFile(next.file);
	}

	/** Returns true if `fm` satisfies a single frontmatter rule. */
	private matchesRule(fm: Record<string, unknown>, rule: FrontmatterRule): boolean {
		if (!(rule.key in fm)) return false;
		if (rule.value !== undefined && rule.value !== "") {
			return String(fm[rule.key]) === rule.value;
		}
		return true;
	}

	/**
	 * Scans all vault markdown files and adds any that match the chain's
	 * include/exclude rules but aren't already members of the chain.
	 * Returns the number of files added.
	 */
	async autoPopulateChain(chain: ChainDefinition): Promise<number> {
		const include = chain.autoPopulateInclude ?? [];
		const exclude = chain.autoPopulateExclude ?? [];

		// Require at least one include rule so we never accidentally add every file
		if (include.length === 0) {
			new Notice(`Chain "${chain.name}" has no include rules — nothing to do.`);
			return 0;
		}

		let added = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
				| Record<string, unknown>
				| undefined;
			if (!fm) continue;

			// Skip files already in this chain
			if (fm[chain.idKey] != null) continue;

			// All include rules must match
			if (!include.every((r) => this.matchesRule(fm, r))) continue;

			// Any exclude rule matching = skip
			if (exclude.some((r) => this.matchesRule(fm, r))) continue;

			await this.addFileToChain(file, chain, true /* silent */);
			added++;
		}
		return added;
	}

	async openChainView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(CHAIN_VIEW_TYPE);
		const firstExisting = existing[0];
		if (firstExisting) {
			this.app.workspace.revealLeaf(firstExisting);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf !== null) {
			await leaf.setViewState({ type: CHAIN_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}

	private openStatusBarChainPicker(): void {
		const active = this.settings.chains.filter(
			(c) => this.findCurrentTask(c) !== undefined
		);
		if (active.length === 0) {
			void this.openChainView();
			return;
		}
		new ChainSuggestModal(this.app, active, async (chain) => {
			this.settings.statusBarChainIdKey = chain.idKey;
			await this.saveSettings();
			this.renderChainBreadcrumb();
		}).open();
	}

	private positionChainBar(): void {
		const el = this.chainStatusBarItem;
		const position = this.settings.chainBarPosition ?? "center";

		// Reset all positional properties before re-applying
		// Use "auto" (not "") so we override the stylesheet's `right: 0` default
		el.style.left = "auto";
		el.style.right = "auto";
		el.style.transform = "";

		if (position === "right") {
			const statusBar = document.querySelector<HTMLElement>(".status-bar");
			if (!statusBar) return;
			const rect = statusBar.getBoundingClientRect();
			// 4px gap between chain bar and status bar
			el.style.right = `${window.innerWidth - rect.left + 4}px`;
		} else if (position === "center") {
			el.style.left = "50%";
			el.style.transform = "translateX(-50%)";
		} else {
			// left
			el.style.left = "12px";
		}
	}

	private setupStatusBarObserver(): void {
		const statusBar = document.querySelector<HTMLElement>(".status-bar");
		if (!statusBar) return;
		this.statusBarObserver?.disconnect();
		this.statusBarObserver = new ResizeObserver(() => this.positionChainBar());
		this.statusBarObserver.observe(statusBar);
		this.register(() => this.statusBarObserver?.disconnect());
		this.positionChainBar();
	}

	private renderEmptyChainBar(el: HTMLElement): void {
		if (this.settings.chains.length === 0) {
			// State A — no schemas at all: offer to create one
			const iconEl = el.createSpan({ cls: "chain-sb-chain-icon" });
			setIcon(iconEl, "link");
			setTooltip(el, "Start a chain", { delay: 0, placement: "top" });
			const addBtn = el.createSpan({ cls: "chain-sb-add-btn chain-sb-add-btn--start" });
			setIcon(addBtn, "plus");
			addBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const file = this.app.workspace.getActiveFile();
				new CreateChainModal(this.app, async (name) => {
					const schema: ChainDefinition = {
						name,
						...derivedChainKeys(slugifyChainName(name) || "chain"),
						currentStatusValue: "current",
						completedStatusValue: "done",
						readyStatusValue: "ready",
					};
					this.settings.chains.push(schema);
					await this.saveSettings();
					if (file) {
						await this.addFileToChain(file, schema);
					} else {
						new Notice("Chain created. Open a file and click + to add it.");
					}
				}).open();
			});
		} else {
			// State B — schemas exist but no file is current yet
			const iconEl = el.createSpan({ cls: "chain-sb-chain-icon" });
			setIcon(iconEl, "link");
			const label = this.settings.chains.length === 1
				? this.settings.chains[0]!.name
				: "Chains";
			setTooltip(iconEl, label, { delay: 0, placement: "top" });
			const arrowEl2 = el.createSpan({ cls: "chain-sb-arrow" });
			setIcon(arrowEl2, "chevron-right");
			const addBtn = el.createSpan({ cls: "chain-sb-add-btn" });
			setIcon(addBtn, "plus");
			setTooltip(addBtn, "Add to chain", { delay: 0, placement: "top" });
			addBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				if (this.settings.chains.length === 1 && this.settings.chains[0]) {
					this.openAddToChainMenu(e, this.settings.chains[0]);
				} else {
					new ChainSuggestModal(this.app, this.settings.chains, (chain) => {
						this.openAddToChainMenu(e, chain);
					}).open();
				}
			});
		}
	}

	private renderChainBreadcrumb(): void {
		if (!this.chainStatusBarItem) return;
		const el = this.chainStatusBarItem;
		el.empty();

		if (!this.settings.chainBarVisible) { this.positionChainBar(); return; }

		// Always anchor to the statusKey-marked current task, not the active file
		const { statusBarChainIdKey } = this.settings;
		const chainsWithCurrent = this.settings.chains.filter(
			(c) => this.findCurrentTask(c) !== undefined
		);
		if (chainsWithCurrent.length === 0) {
			this.renderEmptyChainBar(el);
			this.positionChainBar();
			return;
		}

		const chain =
			(statusBarChainIdKey
				? chainsWithCurrent.find((c) => c.idKey === statusBarChainIdKey)
				: undefined) ?? chainsWithCurrent[0]!;

		const currentTask = this.findCurrentTask(chain);
		if (!currentTask) { this.positionChainBar(); return; }

		const items = this.buildChain(currentTask, chain);
		if (items.length === 0) { this.positionChainBar(); return; }

		// Use the pre-stored main editor file — avoids leaf query timing issues.
		const activeFile = this.mainEditorFile;

		// Chain icon — shows chain name on hover, switches chain on click
		const iconEl = el.createSpan({ cls: "chain-sb-chain-icon" });
		setIcon(iconEl, "link");
		setTooltip(iconEl, chain.name, { delay: 0, placement: "top" });
		iconEl.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openStatusBarChainPicker();
		});
		const firstArrow = el.createSpan({ cls: "chain-sb-arrow" });
		setIcon(firstArrow, "chevron-right");

		const scrollEl = el.createDiv({ cls: "chain-sb-scroll" });

		// Drag state scoped to this render
		let dragSrcIdx = -1;

		const reorder = async (fromIdx: number, toIdx: number) => {
			if (fromIdx === toIdx) return;
			const reordered = [...items];
			const [moved] = reordered.splice(fromIdx, 1);
			reordered.splice(toIdx, 0, moved!);
			for (let i = 0; i < reordered.length; i++) {
				await this.app.fileManager.processFrontMatter(reordered[i]!.file, (fm) => {
					fm[chain.positionKey] = i + 1;
				});
			}
			this.renderChainBreadcrumb();
		};

		let currentNode: HTMLElement | null = null;
		let openFileNode: HTMLElement | null = null;

		items.forEach((item, idx) => {
			if (idx > 0) {
				const arrowEl = scrollEl.createSpan({ cls: "chain-sb-arrow" });
				setIcon(arrowEl, "chevron-right");
			}

			const isOpen = activeFile?.path === item.file.path;

			if (item.role === "current") {
				const node = scrollEl.createSpan({
					cls: "chain-sb-node chain-sb-node--current" + (isOpen ? "" : " is-away"),
					text: item.file.basename,
					attr: { tabindex: "0", role: "button" },
				});
				currentNode = node;
				if (isOpen) openFileNode = node;
				setTooltip(node, item.file.basename, { delay: 0, placement: "top" });
				node.addEventListener("click", async (e) => {
					e.stopPropagation();
					const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
					if (leaf) await leaf.openFile(item.file);
				});
				node.addEventListener("keydown", async (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
						if (leaf) await leaf.openFile(item.file);
					}
				});
				node.addEventListener("contextmenu", (e) => {
					e.stopPropagation();
					const menu = new Menu();
					const nextItem = items[idx + 1];
					if (nextItem) {
						menu.addItem((mi) =>
							mi.setTitle("Advance chain").setIcon("arrow-right").onClick(async () => {
								await this.advanceChain(chain, item.file);
							})
						);
					}
					if (item.role !== "ready") {
						menu.addItem((mi) =>
							mi.setTitle("Mark as ready").setIcon("check-circle").onClick(async () => {
								await this.setItemStatus(item.file, chain, "ready");
							})
						);
					}
					menu.addItem((mi) =>
						mi.setTitle("Mark as done").setIcon("check").onClick(async () => {
							await this.setItemStatus(item.file, chain, "done");
						})
					);
					if (item.role !== "next") {
						menu.addItem((mi) =>
							mi.setTitle("Mark as todo").setIcon("circle").onClick(async () => {
								await this.setItemStatus(item.file, chain, "todo");
							})
						);
					}
					menu.addItem((mi) =>
						mi.setTitle("Open file").setIcon("file-open").onClick(async () => {
							const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
							if (leaf) await leaf.openFile(item.file);
						})
					);
					menu.addItem((mi) =>
						mi.setTitle("Remove from chain").setIcon("trash").onClick(async () => {
							await this.removeFileFromChain(item.file, chain);
						})
					);
					menu.showAtMouseEvent(e);
				});
			} else {
				const node = scrollEl.createSpan({
					cls: `chain-sb-node chain-sb-node--${item.role}${isOpen ? " is-open" : ""}`,
					attr: { tabindex: "0", role: "button" },
				});
				if (isOpen) openFileNode = node;
				if (item.role === "previous" || item.role === "ready") setIcon(node, "check");
				setTooltip(node, item.file.basename, { delay: 0, placement: "top" });

				node.draggable = true;
				node.addEventListener("dragstart", (e) => {
					dragSrcIdx = idx;
					e.dataTransfer?.setData("text/plain", String(idx));
					node.addClass("is-dragging");
				});
				node.addEventListener("dragend", () => {
					node.removeClass("is-dragging");
					scrollEl.querySelectorAll(".chain-sb-drop-before, .chain-sb-drop-after")
						.forEach((n) => { n.removeClass("chain-sb-drop-before"); n.removeClass("chain-sb-drop-after"); });
				});
				node.addEventListener("dragover", (e) => {
					e.preventDefault();
					if (dragSrcIdx === idx) return;
					const rect = node.getBoundingClientRect();
					const mid = rect.left + rect.width / 2;
					scrollEl.querySelectorAll(".chain-sb-node").forEach((n) => {
						n.removeClass("chain-sb-drop-before");
						n.removeClass("chain-sb-drop-after");
					});
					if (e.clientX < mid) node.addClass("chain-sb-drop-before");
					else node.addClass("chain-sb-drop-after");
				});
				node.addEventListener("dragleave", () => {
					node.removeClass("chain-sb-drop-before");
					node.removeClass("chain-sb-drop-after");
				});
				node.addEventListener("drop", async (e) => {
					e.preventDefault();
					node.removeClass("chain-sb-drop-before");
					node.removeClass("chain-sb-drop-after");
					if (dragSrcIdx < 0 || dragSrcIdx === idx) return;
					const rect = node.getBoundingClientRect();
					const insertAfter = e.clientX >= rect.left + rect.width / 2;
					const toIdx = insertAfter ? idx + (dragSrcIdx > idx ? 0 : 0) : idx - (dragSrcIdx < idx ? 0 : 0);
					// Compute clean insertion index
					let target = idx;
					if (insertAfter && dragSrcIdx < idx) target = idx;
					else if (insertAfter && dragSrcIdx > idx) target = idx + 1;
					else if (!insertAfter && dragSrcIdx < idx) target = idx - 1;
					else target = idx;
					await reorder(dragSrcIdx, target);
				});

				node.addEventListener("click", async (e) => {
					e.stopPropagation();
					const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
					if (leaf) await leaf.openFile(item.file);
				});
				node.addEventListener("keydown", async (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
						if (leaf) await leaf.openFile(item.file);
					}
				});
				node.addEventListener("contextmenu", (e) => {
					e.stopPropagation();
					const menu = new Menu();
					if (item.role !== "current") {
						menu.addItem((mi) =>
							mi.setTitle("Set as current").setIcon("map-pin").onClick(async () => {
								await this.setCurrentTask(item.file, chain);
							})
						);
					}
					if (item.role !== "ready") {
						menu.addItem((mi) =>
							mi.setTitle("Mark as ready").setIcon("check-circle").onClick(async () => {
								await this.setItemStatus(item.file, chain, "ready");
							})
						);
					}
					if (item.role !== "previous") {
						menu.addItem((mi) =>
							mi.setTitle("Mark as done").setIcon("check").onClick(async () => {
								await this.setItemStatus(item.file, chain, "done");
							})
						);
					}
					if (item.role !== "next") {
						menu.addItem((mi) =>
							mi.setTitle("Mark as todo").setIcon("circle").onClick(async () => {
								await this.setItemStatus(item.file, chain, "todo");
							})
						);
					}
					menu.addItem((mi) =>
						mi.setTitle("Open file").setIcon("file-open").onClick(async () => {
							const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
							if (leaf) await leaf.openFile(item.file);
						})
					);
					menu.addItem((mi) =>
						mi.setTitle("Remove from chain").setIcon("trash").onClick(async () => {
							await this.removeFileFromChain(item.file, chain);
						})
					);
					menu.showAtMouseEvent(e);
				});
			}
		});

		// After layout: size container based on current-task window, scroll to show open file.
		// Use offsetLeft relative to scrollEl to get stable scroll-content positions.
		requestAnimationFrame(() => {
			const maxVisible = this.settings.statusBarDisplayMode === "filenames"
				? (this.settings.statusBarMaxItems ?? 5)
				: (this.settings.statusBarDotsCount ?? 7);
			const itemNodes = Array.from(scrollEl.querySelectorAll(".chain-sb-node")) as HTMLElement[];
			if (itemNodes.length <= maxVisible) return;

			// offsetLeft of each node is relative to the fixed-position ancestor.
			// Subtract scrollEl's own offsetLeft to get position within scroll content.
			const scrollElLeft = scrollEl.offsetLeft;
			const contentLeft  = (node: HTMLElement) => node.offsetLeft - scrollElLeft;
			const contentRight = (node: HTMLElement) => node.offsetLeft + node.offsetWidth - scrollElLeft;

			// ── Size: window centered on the current task (contains the text node) ──
			const sizeIdx = currentNode ? itemNodes.indexOf(currentNode) : 0;
			const half = Math.floor((maxVisible - 1) / 2);
			let sStart = Math.max(0, sizeIdx - half);
			let sEnd = sStart + maxVisible;
			if (sEnd > itemNodes.length) { sEnd = itemNodes.length; sStart = Math.max(0, sEnd - maxVisible); }

			const sFirstNode = itemNodes[sStart];
			const sLastNode  = itemNodes[sEnd - 1];
			if (!sFirstNode || !sLastNode) return;

			const windowWidth = contentRight(sLastNode) - contentLeft(sFirstNode);
			scrollEl.style.maxWidth = `${windowWidth}px`;

			// ── Scroll: center on the open file (if in chain), else on current task ──
			const openIdx = openFileNode ? itemNodes.indexOf(openFileNode) : -1;
			const scrollIdx = openIdx >= 0 ? openIdx : sizeIdx;
			let pStart = Math.max(0, scrollIdx - half);
			let pEnd = pStart + maxVisible;
			if (pEnd > itemNodes.length) { pEnd = itemNodes.length; pStart = Math.max(0, pEnd - maxVisible); }

			const pFirstNode = itemNodes[pStart];
			if (!pFirstNode) return;
			const targetScrollLeft = contentLeft(pFirstNode);

			// Clamp so the visible area is always full (no empty space on the right)
			const maxScrollLeft = Math.max(0, scrollEl.scrollWidth - windowWidth);
			scrollEl.scrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScrollLeft));
		});

		// "+" button to add a file to the chain — lives outside the scroll area
		const lastArrow = el.createSpan({ cls: "chain-sb-arrow" });
		setIcon(lastArrow, "chevron-right");
		const addBtn = el.createSpan({ cls: "chain-sb-add-btn" });
		setIcon(addBtn, "plus");
		setTooltip(addBtn, "Add to chain", { delay: 0, placement: "top" });
		addBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openAddToChainMenu(e, chain);
		});

		this.positionChainBar();
	}
}

/**
 * Multi-select modal for choosing one or more chains to remove a file from.
 * Each chain is shown as a toggleable row; "Remove" confirms the selection.
 */
class ChainMultiSelectModal extends Modal {
	private chains: ChainDefinition[];
	private onConfirm: (selected: ChainDefinition[]) => Promise<void>;
	private selected: Set<string> = new Set();

	constructor(
		app: App,
		chains: ChainDefinition[],
		onConfirm: (selected: ChainDefinition[]) => Promise<void>
	) {
		super(app);
		this.chains = chains;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Remove from chain" });
		contentEl.createEl("p", {
			text: "Select the chain(s) to remove this file from.",
			cls: "chain-create-modal-desc",
		});

		const rows: { chain: ChainDefinition; row: HTMLElement }[] = [];

		for (const chain of this.chains) {
			const row = contentEl.createDiv({ cls: "chain-multiselect-row" });
			const checkbox = row.createEl("input", { type: "checkbox" });
			checkbox.id = `chain-ms-${chain.idKey}`;
			row.createEl("label", { text: chain.name, attr: { for: checkbox.id } });
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) this.selected.add(chain.idKey);
				else this.selected.delete(chain.idKey);
				confirmBtn.disabled = this.selected.size === 0;
			});
			rows.push({ chain, row });
		}

		let confirmBtn: HTMLButtonElement;
		new Setting(contentEl)
			.addButton((btn) => {
				btn.setButtonText("Remove").setCta().setDisabled(true);
				confirmBtn = btn.buttonEl;
				btn.onClick(async () => {
					const selected = this.chains.filter((c) => this.selected.has(c.idKey));
					this.close();
					await this.onConfirm(selected);
				});
			})
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class CreateChainModal extends Modal {
	private onSubmit: (name: string) => Promise<void>;

	constructor(app: App, onSubmit: (name: string) => Promise<void>) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Create a chain" });
		contentEl.createEl("p", {
			text: "Give your chain a name. A chain groups related notes and tracks which one you're working on.",
			cls: "chain-create-modal-desc",
		});

		let nameValue = "";

		new Setting(contentEl)
			.setName("Chain name")
			.addText((text) => {
				text.setPlaceholder("e.g. Project Alpha");
				text.onChange((v) => { nameValue = v; });
				// Focus after the modal DOM is ready
				setTimeout(() => text.inputEl.focus(), 0);
				text.inputEl.addEventListener("keydown", async (e: KeyboardEvent) => {
					if (e.key === "Enter" && nameValue.trim()) {
						this.close();
						await this.onSubmit(nameValue.trim());
					}
				});
			});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Create")
				.setCta()
				.onClick(async () => {
					if (!nameValue.trim()) return;
					this.close();
					await this.onSubmit(nameValue.trim());
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Prompt for a Linear state name to push to an issue.
 */
class LinearPushStateModal extends Modal {
	private onSubmit: (stateName: string) => Promise<void>;

	constructor(app: App, onSubmit: (stateName: string) => Promise<void>) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Push status to Linear" });
		contentEl.createEl("p", {
			text: "Enter the Linear state name to apply to this issue (e.g. \"In Progress\", \"Done\").",
			cls: "chain-create-modal-desc",
		});

		let value = "";

		new Setting(contentEl)
			.setName("State name")
			.addText((text) => {
				text.setPlaceholder("In Progress");
				text.onChange((v) => { value = v; });
				setTimeout(() => text.inputEl.focus(), 0);
				text.inputEl.addEventListener("keydown", async (e: KeyboardEvent) => {
					if (e.key === "Enter" && value.trim()) {
						this.close();
						await this.onSubmit(value.trim());
					}
				});
			});

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Push").setCta().onClick(async () => {
				if (!value.trim()) return;
				this.close();
				await this.onSubmit(value.trim());
			})
		);
	}

	onClose(): void { this.contentEl.empty(); }
}

/**
 * OAuth flow modal — for now a manual token-paste approach.
 * A future version can register a custom URI handler to receive the callback.
 */
class LinearOAuthModal extends Modal {
	private workspaceId: string;
	private onToken: (token: string) => Promise<void>;

	constructor(app: App, workspaceId: string, onToken: (token: string) => Promise<void>) {
		super(app);
		this.workspaceId = workspaceId;
		this.onToken = onToken;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Connect Linear workspace" });
		contentEl.createEl("p", {
			text: "For now, paste a Personal API key or an OAuth access token obtained from Linear. Full browser-based OAuth (one-click) will be added in a future update.",
			cls: "chain-create-modal-desc",
		});

		let token = "";

		new Setting(contentEl)
			.setName("Access token")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("lin_api_… or OAuth token");
				text.onChange((v) => { token = v; });
				setTimeout(() => text.inputEl.focus(), 0);
			});

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Connect").setCta().onClick(async () => {
				if (!token.trim()) return;
				this.close();
				await this.onToken(token.trim());
			})
		).addButton((btn) =>
			btn.setButtonText("Cancel").onClick(() => this.close())
		);
	}

	onClose(): void { this.contentEl.empty(); }
}
