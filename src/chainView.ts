import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import TaskToolsPlugin from "./main";
import type { ChainDefinition, ChainItem } from "./types";

export const CHAIN_VIEW_TYPE = "task-tools-chain-view";

export class ChainView extends ItemView {
	plugin: TaskToolsPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: TaskToolsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CHAIN_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Chain";
	}

	getIcon(): string {
		return "link";
	}

	async onOpen(): Promise<void> {
		this.render();

		this.registerEvent(
			this.app.metadataCache.on("changed", () => this.render())
		);
	}

	async onClose(): Promise<void> {}

	render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("chain-view-container");

		const chains = this.plugin.settings.chains;

		if (chains.length === 0) {
			container.createEl("p", {
				text: "No chain schemas defined. Add one in Settings.",
				cls: "chain-view-empty",
			});
			return;
		}

		chains.forEach((chain) => {
			this.renderChainSection(container, chain);
		});
	}

	private renderChainSection(container: HTMLElement, chain: ChainDefinition): void {
		const section = container.createEl("div", { cls: "chain-view-section" });
		section.createEl("div", { text: chain.name, cls: "chain-view-section-header" });

		const currentTask = this.plugin.findCurrentTask(chain);

		if (!currentTask) {
			section.createEl("p", {
				text: "No current task set.",
				cls: "chain-view-empty chain-view-empty--inline",
			});
			return;
		}

		const items = this.plugin.buildChain(currentTask, chain);

		if (items.length === 0) {
			section.createEl("p", {
				text: "Current task is not part of a chain.",
				cls: "chain-view-empty chain-view-empty--inline",
			});
			return;
		}

		const trackEl = section.createEl("div", { cls: "chain-view-track" });
		const detailEl = section.createEl("div", { cls: "chain-view-detail" });

		let dragSrcIdx: number | null = null;
		const wrappers: HTMLElement[] = [];

		const clearDropIndicators = () => {
			wrappers.forEach((w) => w.classList.remove("drop-before", "drop-after"));
		};

		items.forEach((item, idx) => {
			const wrapper = trackEl.createEl("div", { cls: "chain-view-dot-wrapper" });
			wrapper.draggable = true;
			wrappers.push(wrapper);

			const dot = wrapper.createEl("div", {
				cls: `chain-view-dot chain-view-dot--${item.role}`,
			});

			// Instant tooltip appended to body to avoid sidebar clipping
			const tip = document.body.createEl("div", {
				text: item.file.basename,
				cls: "chain-dot-tip",
			});
			dot.addEventListener("mouseenter", () => {
				const rect = dot.getBoundingClientRect();
				tip.style.left = `${rect.left + rect.width / 2}px`;
				tip.style.top = `${rect.bottom + 6}px`;
				tip.classList.add("chain-dot-tip--visible");
			});
			dot.addEventListener("mouseleave", () => {
				tip.classList.remove("chain-dot-tip--visible");
			});
			// Clean up when view closes
			this.register(() => tip.remove());

			// ── Click to show detail ──────────────────────────────────────
			dot.addEventListener("click", () => {
				const isActive = dot.classList.contains("is-active");
				trackEl.querySelectorAll(".chain-view-dot.is-active").forEach((d) =>
					d.classList.remove("is-active")
				);
				if (isActive) {
					detailEl.empty();
					detailEl.classList.remove("is-visible");
				} else {
					dot.classList.add("is-active");
					this.renderDetailPanel(detailEl, item, idx, items, chain);
					detailEl.classList.add("is-visible");
				}
			});

			// ── Drag to reorder ───────────────────────────────────────────
			wrapper.addEventListener("dragstart", (e) => {
				dragSrcIdx = idx;
				wrapper.classList.add("is-dragging");
				if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
			});

			wrapper.addEventListener("dragend", () => {
				dragSrcIdx = null;
				wrapper.classList.remove("is-dragging");
				clearDropIndicators();
			});

			wrapper.addEventListener("dragover", (e) => {
				e.preventDefault();
				if (dragSrcIdx === null || dragSrcIdx === idx) return;
				if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
				const rect = wrapper.getBoundingClientRect();
				const insertBefore = e.clientX < rect.left + rect.width / 2;
				clearDropIndicators();
				wrapper.classList.add(insertBefore ? "drop-before" : "drop-after");
			});

			wrapper.addEventListener("dragleave", (e) => {
				// Only clear if leaving to outside this wrapper entirely
				if (!wrapper.contains(e.relatedTarget as Node)) {
					wrapper.classList.remove("drop-before", "drop-after");
				}
			});

			wrapper.addEventListener("drop", async (e) => {
				e.preventDefault();
				if (dragSrcIdx === null || dragSrcIdx === idx) return;

				const rect = wrapper.getBoundingClientRect();
				const insertBefore = e.clientX < rect.left + rect.width / 2;

				// Build new ordered array
				const src = dragSrcIdx;
				const draggedItem = items[src];
				if (!draggedItem) return;
				const newOrder = items.filter((_, i) => i !== src);
				const targetIdx = newOrder.indexOf(item);
				newOrder.splice(insertBefore ? targetIdx : targetIdx + 1, 0, draggedItem);

				// Write sequential positions to all files
				for (let i = 0; i < newOrder.length; i++) {
					const entry = newOrder[i];
					if (!entry) continue;
					await this.app.fileManager.processFrontMatter(entry.file, (front) => {
						front[chain.positionKey] = i + 1;
					});
				}
			});
		});
	}

	private renderDetailPanel(
		detailEl: HTMLElement,
		item: ChainItem,
		idx: number,
		items: ChainItem[],
		chain: ChainDefinition
	): void {
		detailEl.empty();

		const nameEl = detailEl.createEl("span", {
			text: item.file.basename,
			cls: "chain-view-detail__name chain-view-item--clickable",
		});
		nameEl.addEventListener("click", async () => {
			const leaf = this.app.workspace.getMostRecentLeaf();
			if (leaf) await leaf.openFile(item.file);
		});

		detailEl.createEl("span", {
			text: item.role,
			cls: "chain-view-item__role",
		});

		// Reorder buttons
		const reorderEl = detailEl.createEl("span", { cls: "chain-view-item__reorder" });

		const upBtn = reorderEl.createEl("button", {
			cls: "chain-view-reorder-btn",
			text: "↑",
			attr: { "aria-label": "Move up" },
		});
		if (idx === 0) upBtn.disabled = true;
		const prevItem = items[idx - 1];
		upBtn.addEventListener("click", async () => {
			if (idx > 0 && prevItem) await this.swapOrder(item, prevItem, chain);
		});

		const downBtn = reorderEl.createEl("button", {
			cls: "chain-view-reorder-btn",
			text: "↓",
			attr: { "aria-label": "Move down" },
		});
		if (idx === items.length - 1) downBtn.disabled = true;
		const nextItem = items[idx + 1];
		downBtn.addEventListener("click", async () => {
			if (idx < items.length - 1 && nextItem) await this.swapOrder(item, nextItem, chain);
		});

		// Set as current
		if (item.role !== "current") {
			const setBtn = detailEl.createEl("button", {
				cls: "chain-view-set-current-btn",
				text: "Set current",
				attr: { "aria-label": `Set ${item.file.basename} as current task` },
			});
			setBtn.addEventListener("click", async () => {
				await this.plugin.setCurrentTask(item.file, chain);
			});
		}

		// Other chains this task belongs to
		const otherChains = this.plugin.getChainsForFile(item.file).filter(
			(c) => c.idKey !== chain.idKey
		);
		if (otherChains.length > 0) {
			const tagsEl = detailEl.createEl("span", { cls: "chain-view-item__tags" });
			otherChains.forEach((c) => {
				tagsEl.createEl("span", { text: c.name, cls: "chain-view-item__tag" });
			});
		}
	}

	private async swapOrder(a: ChainItem, b: ChainItem, chain: ChainDefinition | undefined): Promise<void> {
		if (!chain) return;
		const orderA = a.order;
		const orderB = b.order;

		await this.app.fileManager.processFrontMatter(a.file, (front) => {
			front[chain.positionKey] = orderB;
		});
		await this.app.fileManager.processFrontMatter(b.file, (front) => {
			front[chain.positionKey] = orderA;
		});
	}
}
