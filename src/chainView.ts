import { ItemView, Menu, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import TaskToolsPlugin from "./main";
import type { ChainDefinition, ChainItem } from "./types";

export const CHAIN_VIEW_TYPE = "task-tools-chain-view";

export class ChainView extends ItemView {
	plugin: TaskToolsPlugin;
	private viewModes: Map<string, "dots" | "list"> = new Map();

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

		const header = section.createEl("div", { cls: "chain-view-section-header-row" });
		header.createEl("div", { text: chain.name, cls: "chain-view-section-header" });

		// View toggle buttons
		const toggleGroup = header.createEl("div", { cls: "chain-view-toggle-group" });
		const dotsBtn = toggleGroup.createEl("button", { cls: "chain-view-toggle-btn", attr: { "aria-label": "Dots view" } });
		setIcon(dotsBtn, "more-horizontal");
		const listBtn = toggleGroup.createEl("button", { cls: "chain-view-toggle-btn", attr: { "aria-label": "List view" } });
		setIcon(listBtn, "list");

		const mode = this.viewModes.get(chain.idKey) ?? "dots";
		if (mode === "dots") dotsBtn.classList.add("is-active");
		else listBtn.classList.add("is-active");

		const trackWrapper = section.createEl("div");

		const switchMode = (newMode: "dots" | "list") => {
			this.viewModes.set(chain.idKey, newMode);
			dotsBtn.classList.toggle("is-active", newMode === "dots");
			listBtn.classList.toggle("is-active", newMode === "list");
			trackWrapper.empty();
			if (currentTask && items.length > 0) {
				if (newMode === "dots") renderDots(trackWrapper);
				else renderList(trackWrapper);
			}
		};

		dotsBtn.addEventListener("click", () => switchMode("dots"));
		listBtn.addEventListener("click", () => switchMode("list"));

		const currentTask = this.plugin.findCurrentTask(chain);

		if (!currentTask) {
			trackWrapper.createEl("p", {
				text: "No current task set.",
				cls: "chain-view-empty chain-view-empty--inline",
			});
			return;
		}

		const items = this.plugin.buildChain(currentTask, chain);

		if (items.length === 0) {
			trackWrapper.createEl("p", {
				text: "Current task is not part of a chain.",
				cls: "chain-view-empty chain-view-empty--inline",
			});
			return;
		}

		const detailEl = section.createEl("div", { cls: "chain-view-detail" });

		const renderDots = (parent: HTMLElement) => {
			const trackEl = parent.createEl("div", { cls: "chain-view-track" });

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
				this.register(() => tip.remove());

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
					if (!wrapper.contains(e.relatedTarget as Node)) {
						wrapper.classList.remove("drop-before", "drop-after");
					}
				});
				wrapper.addEventListener("drop", async (e) => {
					e.preventDefault();
					if (dragSrcIdx === null || dragSrcIdx === idx) return;
					const rect = wrapper.getBoundingClientRect();
					const insertBefore = e.clientX < rect.left + rect.width / 2;
					const src = dragSrcIdx;
					const draggedItem = items[src];
					if (!draggedItem) return;
					const newOrder = items.filter((_, i) => i !== src);
					const targetIdx = newOrder.indexOf(item);
					newOrder.splice(insertBefore ? targetIdx : targetIdx + 1, 0, draggedItem);
					for (let i = 0; i < newOrder.length; i++) {
						const entry = newOrder[i];
						if (!entry) continue;
						await this.app.fileManager.processFrontMatter(entry.file, (front) => {
							front[chain.positionKey] = i + 1;
						});
					}
				});
			});
		};

		const renderList = (parent: HTMLElement) => {
			const listEl = parent.createEl("div", { cls: "chain-view-list" });

			let dragSrcIdx: number | null = null;
			const rows: HTMLElement[] = [];

			const clearDropIndicators = () => {
				rows.forEach((r) => r.classList.remove("drop-before", "drop-after"));
			};

				// After a drag reorder: reassign positions and statuses based on new order.
				// Explicitly writes status to every item to prevent stale frontmatter.
				const reassignStatuses = async (newItems: ChainItem[], currentWasDragged: boolean) => {
					const currentIdx = newItems.findIndex((i) => i.role === "current");
					const readyVal = chain.readyStatusValue ?? "ready";

					// Case A: current dragged EARLIER - done items now appear after it.
					// current becomes done, first todo/ready after it becomes new current.
					const doneAfterCurrent = currentWasDragged &&
						newItems.slice(currentIdx + 1).some((i) => i.role === "previous");

					// Case B: current dragged LATER - todo/ready items now appear before it.
					// last todo/ready before current becomes new current, old current becomes todo.
					const todoBeforeCurrent = currentWasDragged &&
						newItems.slice(0, currentIdx).some(
							(i) => i.role === "next" || i.role === "ready"
						);

					if (doneAfterCurrent) {
						let newCurrentIdx = -1;
						for (let i = currentIdx + 1; i < newItems.length; i++) {
							const r = newItems[i]!.role;
							if (r === "next" || r === "ready") { newCurrentIdx = i; break; }
						}
						for (let i = 0; i < newItems.length; i++) {
							const itm = newItems[i]!;
							await this.app.fileManager.processFrontMatter(itm.file, (front) => {
								front[chain.positionKey] = i + 1;
								if (newCurrentIdx === -1 || i < newCurrentIdx) {
									front[chain.statusKey] = chain.completedStatusValue;
								} else if (i === newCurrentIdx) {
									front[chain.statusKey] = chain.currentStatusValue;
								} else {
									if (front[chain.statusKey] !== readyVal) delete front[chain.statusKey];
								}
							});
						}
					} else if (todoBeforeCurrent) {
						// Find the last todo/ready before current - that becomes new current
						let newCurrentIdx = -1;
						for (let i = currentIdx - 1; i >= 0; i--) {
							const r = newItems[i]!.role;
							if (r === "next" || r === "ready") { newCurrentIdx = i; break; }
						}
						for (let i = 0; i < newItems.length; i++) {
							const itm = newItems[i]!;
							await this.app.fileManager.processFrontMatter(itm.file, (front) => {
								front[chain.positionKey] = i + 1;
								if (i < newCurrentIdx) {
									// Preserve: done stays done, todo stays todo
									if (itm.role === "previous") {
										front[chain.statusKey] = chain.completedStatusValue;
									} else {
										if (front[chain.statusKey] !== readyVal) delete front[chain.statusKey];
									}
								} else if (i === newCurrentIdx) {
									front[chain.statusKey] = chain.currentStatusValue;
								} else {
									// Old current and everything after becomes todo
									if (front[chain.statusKey] !== readyVal) delete front[chain.statusKey];
								}
							});
						}
					} else {
						// Normal case: a non-current item was dragged.
						for (let i = 0; i < newItems.length; i++) {
							const itm = newItems[i]!;
							await this.app.fileManager.processFrontMatter(itm.file, (front) => {
								front[chain.positionKey] = i + 1;
								if (i < currentIdx) {
									front[chain.statusKey] = chain.completedStatusValue;
								} else if (i === currentIdx) {
									front[chain.statusKey] = chain.currentStatusValue;
								} else {
									if (front[chain.statusKey] !== readyVal) delete front[chain.statusKey];
								}
							});
						}
					}
				};


			items.forEach((item, idx) => {
				const row = listEl.createEl("div", { cls: `chain-view-list-row chain-view-list-row--${item.role}` });
				row.draggable = true;
				rows.push(row);

				// Dot
				const dot = row.createEl("span", { cls: `chain-view-list-dot chain-sb-node--${item.role}` });
				if (item.role === "previous" || item.role === "ready") setIcon(dot, "check");

				// Name
				row.createEl("span", {
					text: item.file.basename,
					cls: "chain-view-list-name" + (item.role === "current" ? " chain-view-list-name--current" : ""),
				});

				// Click to open
				const open = async () => {
					const leaf = this.app.workspace.getMostRecentLeaf();
					if (leaf) await leaf.openFile(item.file);
				};
				row.addEventListener("click", open);

				// Drag events
				row.addEventListener("dragstart", (e) => {
					dragSrcIdx = idx;
					row.classList.add("is-dragging");
					if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
				});
				row.addEventListener("dragend", () => {
					dragSrcIdx = null;
					row.classList.remove("is-dragging");
					clearDropIndicators();
				});
				row.addEventListener("dragover", (e) => {
					e.preventDefault();
					if (dragSrcIdx === null || dragSrcIdx === idx) return;
					if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
					clearDropIndicators();
					const rect = row.getBoundingClientRect();
					row.classList.add(e.clientY < rect.top + rect.height / 2 ? "drop-before" : "drop-after");
				});
				row.addEventListener("dragleave", (e) => {
					if (!row.contains(e.relatedTarget as Node)) {
						row.classList.remove("drop-before", "drop-after");
					}
				});
				row.addEventListener("drop", async (e) => {
					e.preventDefault();
					if (dragSrcIdx === null || dragSrcIdx === idx) return;
					const src = dragSrcIdx;
					const draggedItem = items[src]!;
					const rect = row.getBoundingClientRect();
					const insertBefore = e.clientY < rect.top + rect.height / 2;
					const newOrder = items.filter((_, i) => i !== src);
					const targetIdx = newOrder.indexOf(item);
					newOrder.splice(insertBefore ? targetIdx : targetIdx + 1, 0, draggedItem);
					await reassignStatuses(newOrder, draggedItem.role === "current");
				});

				// Right-click context menu — show every status the item isn't currently in
				row.addEventListener("contextmenu", (e) => {
					e.preventDefault();
					const menu = new Menu();

					if (item.role === "current") {
						// Advance chain is the canonical "done + open next" action
						const nextItem = items[idx + 1];
						if (nextItem) {
							menu.addItem((mi) =>
								mi.setTitle("Advance chain").setIcon("arrow-right").onClick(async () => {
									await this.plugin.advanceChain(chain, item.file);
								})
							);
						}
					}

					if (item.role !== "current") {
						menu.addItem((mi) =>
							mi.setTitle("Set as current").setIcon("map-pin").onClick(async () => {
								await this.plugin.setCurrentTask(item.file, chain);
							})
						);
					}

					if (item.role !== "ready") {
						menu.addItem((mi) =>
							mi.setTitle("Mark as ready").setIcon("check-circle").onClick(async () => {
								await this.plugin.setItemStatus(item.file, chain, "ready");
							})
						);
					}

					if (item.role !== "previous") {
						menu.addItem((mi) =>
							mi.setTitle("Mark as done").setIcon("check").onClick(async () => {
								await this.plugin.setItemStatus(item.file, chain, "done");
							})
						);
					}

					if (item.role !== "next") {
						menu.addItem((mi) =>
							mi.setTitle("Mark as todo").setIcon("circle").onClick(async () => {
								await this.plugin.setItemStatus(item.file, chain, "todo");
							})
						);
					}

					menu.addItem((mi) =>
						mi.setTitle("Open file").setIcon("file-open").onClick(open)
					);
					menu.showAtMouseEvent(e);
				});
			});
		};

		// Initial render
		if (mode === "dots") renderDots(trackWrapper);
		else renderList(trackWrapper);
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

		const roleLabel = item.role === "previous" ? "Done" : item.role === "current" ? "Current" : item.role === "ready" ? "Ready" : "Todo";
		detailEl.createEl("span", {
			text: roleLabel,
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
