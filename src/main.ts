import { Menu, Notice, Plugin, TFile, setIcon, setTooltip } from "obsidian";
import {
	DEFAULT_SETTINGS,
	TaskToolsSettings,
	TaskToolsSettingTab,
} from "./settings";
import { CHAIN_VIEW_TYPE, ChainView } from "./chainView";
import { NewTaskModal } from "./newTaskModal";
import { ChainSuggestModal } from "./chainSuggestModal";
import { ChainInstanceSuggestModal } from "./chainInstanceSuggestModal";
import type { ChainDefinition, ChainItem, FrontmatterRule } from "./types";

export default class TaskToolsPlugin extends Plugin {
	settings: TaskToolsSettings;
	private chainStatusBarItem: HTMLElement;
	private statusBarObserver: ResizeObserver | null = null;

	/**
	 * Index: key = "${idKey}::${chainId}", value = Set of file paths.
	 * Lets buildChain and findCurrentTask avoid full vault scans.
	 */
	private chainIndex: Map<string, Set<string>> = new Map();

	async onload() {
		await this.loadSettings();

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
		setTooltip(this.chainStatusBarItem, "Click to switch chain", { delay: 0 });
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

		// Re-render chain bar when the active file changes
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.renderChainBreadcrumb();
			})
		);

		this.addSettingTab(new TaskToolsSettingTab(this.app, this));

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
	}

	onunload() {}

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

		await this.app.fileManager.processFrontMatter(file, (front) => {
			front[chain.idKey] = chainId;
			front[chain.positionKey] = nextPos;
		});

		// If the chain has no current task yet, set this file as current
		if (!this.findCurrentTask(chain)) {
			await this.setCurrentTask(file, chain);
		}

		if (!silent) new Notice(`Added "${file.basename}" to chain "${chainId}" at position ${nextPos}.`);
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

			let role: "previous" | "current" | "next";
			if (isCurrent) {
				role = "current";
			} else if (fileOrder < currentOrder) {
				role = "previous";
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
		const leaf = this.app.workspace.getMostRecentLeaf();
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
		const statusBar = document.querySelector<HTMLElement>(".status-bar");
		if (!statusBar) return;
		const rect = statusBar.getBoundingClientRect();
		// 4px gap between chain bar and status bar
		this.chainStatusBarItem.style.right = `${window.innerWidth - rect.left + 4}px`;
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

	private renderChainBreadcrumb(): void {
		const el = this.chainStatusBarItem;
		el.empty();

		if (!this.settings.chainBarVisible) { this.positionChainBar(); return; }

		// Always anchor to the statusKey-marked current task, not the active file
		const { statusBarChainIdKey } = this.settings;
		const chainsWithCurrent = this.settings.chains.filter(
			(c) => this.findCurrentTask(c) !== undefined
		);
		if (chainsWithCurrent.length === 0) { this.positionChainBar(); return; }

		const chain =
			(statusBarChainIdKey
				? chainsWithCurrent.find((c) => c.idKey === statusBarChainIdKey)
				: undefined) ?? chainsWithCurrent[0]!;

		const currentTask = this.findCurrentTask(chain);
		if (!currentTask) { this.positionChainBar(); return; }

		const items = this.buildChain(currentTask, chain);
		if (items.length === 0) { this.positionChainBar(); return; }

		// Track which file is currently open for accent highlighting
		const activeFile = this.app.workspace.getActiveFile();

		// Chain icon — shows chain name on hover, switches chain on click
		const iconEl = el.createSpan({ cls: "chain-sb-chain-icon" });
		setIcon(iconEl, "link");
		setTooltip(iconEl, chain.name, { delay: 0 });
		iconEl.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openStatusBarChainPicker();
		});
		el.createSpan({ cls: "chain-sb-arrow", text: "→" });

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

		items.forEach((item, idx) => {
			if (idx > 0) {
				el.createSpan({ cls: "chain-sb-arrow", text: "→" });
			}

			const isOpen = activeFile?.path === item.file.path;

			if (item.role === "current") {
				const node = el.createSpan({
					cls: "chain-sb-node chain-sb-node--current" + (isOpen ? "" : " is-away"),
					text: item.file.basename,
				});
				setTooltip(node, item.file.basename, { delay: 0 });
				node.addEventListener("click", async (e) => {
					e.stopPropagation();
					const leaf = this.app.workspace.getMostRecentLeaf();
					if (leaf) await leaf.openFile(item.file);
				});
				node.addEventListener("contextmenu", (e) => {
					e.stopPropagation();
					const menu = new Menu();
					menu.addItem((menuItem) =>
						menuItem
							.setTitle("Advance chain")
							.setIcon("arrow-right")
							.onClick(async () => {
								await this.advanceChain(chain, item.file);
								this.renderChainBreadcrumb();
							})
					);
					menu.showAtMouseEvent(e);
				});
			} else {
				const node = el.createSpan({
					cls: `chain-sb-node chain-sb-node--${item.role}${isOpen ? " is-open" : ""}`,
				});
				if (item.role === "previous") setIcon(node, "check");
				setTooltip(node, item.file.basename, { delay: 0 });

				node.draggable = true;
				node.addEventListener("dragstart", (e) => {
					dragSrcIdx = idx;
					e.dataTransfer?.setData("text/plain", String(idx));
					node.addClass("is-dragging");
				});
				node.addEventListener("dragend", () => {
					node.removeClass("is-dragging");
					el.querySelectorAll(".chain-sb-drop-before, .chain-sb-drop-after")
						.forEach((n) => { n.removeClass("chain-sb-drop-before"); n.removeClass("chain-sb-drop-after"); });
				});
				node.addEventListener("dragover", (e) => {
					e.preventDefault();
					if (dragSrcIdx === idx) return;
					const rect = node.getBoundingClientRect();
					const mid = rect.left + rect.width / 2;
					el.querySelectorAll(".chain-sb-node").forEach((n) => {
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
					const leaf = this.app.workspace.getMostRecentLeaf();
					if (leaf) await leaf.openFile(item.file);
				});
				node.addEventListener("contextmenu", (e) => {
					e.stopPropagation();
					const menu = new Menu();
					menu.addItem((menuItem) =>
						menuItem
							.setTitle("Set as current task")
							.setIcon("map-pin")
							.onClick(async () => {
								await this.setCurrentTask(item.file, chain);
								this.renderChainBreadcrumb();
							})
					);
					menu.showAtMouseEvent(e);
				});
			}
		});

		// "+" button to add the active file to the chain
		el.createSpan({ cls: "chain-sb-arrow", text: "→" });
		const addBtn = el.createSpan({ cls: "chain-sb-add-btn" });
		setIcon(addBtn, "plus");
		setTooltip(addBtn, "Add active file to chain", { delay: 0 });
		addBtn.addEventListener("click", async (e) => {
			e.stopPropagation();
			const file = this.app.workspace.getActiveFile();
			if (!file) { new Notice("No active file."); return; }
			await this.addFileToChain(file, chain);
		});

		this.positionChainBar();
	}
}
