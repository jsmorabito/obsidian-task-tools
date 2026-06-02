import { AbstractInputSuggest, App, PluginSettingTab, Setting, TFile } from "obsidian";
import type { ChainDefinition, FrontmatterRule, LinearWorkspaceConfig } from "./types";
import TaskToolsPlugin from "./main";

export type StatusBarDisplayMode = "filenames" | "dots";
export type ChainBarPosition = "left" | "center" | "right";

export interface TaskToolsSettings {
	taskFrontmatterKey: string;
	taskFrontmatterValue: string;
	taskFolder: string;
	taskTemplatePath: string;
	statusBarChainIdKey: string; // idKey of the chain shown in the status bar
	statusBarDisplayMode: StatusBarDisplayMode;
	statusBarDotsCount: number; // max visible dots at a time
	chainBarVisible: boolean;
	chainBarPosition: ChainBarPosition;
	chains: ChainDefinition[];
	// Linear integration
	linearWorkspaces: LinearWorkspaceConfig[];
	linearSyncOnOpen: boolean;
	linearSyncIntervalMinutes: number; // 0 = disabled
	linearIssueFolder: string; // folder where imported issues are created
}

/** Convert a display name to a lowercase kebab-case slug, e.g. "My Chain" → "my-chain". */
export function slugifyChainName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Return the three auto-derived key names for a given chain slug. */
export function derivedChainKeys(slug: string): { idKey: string; positionKey: string; statusKey: string } {
	return { idKey: `${slug}-chain`, positionKey: `${slug}-chain-position`, statusKey: `${slug}-chain-status` };
}

export const DEFAULT_CHAIN: ChainDefinition = {
	name: "Project Chain",
	...derivedChainKeys(slugifyChainName("Project Chain")),
	currentStatusValue: "current",
	completedStatusValue: "done",
	readyStatusValue: "ready",
};

export const DEFAULT_SETTINGS: TaskToolsSettings = {
	taskFrontmatterKey: "type",
	taskFrontmatterValue: "task",
	taskFolder: "",
	taskTemplatePath: "",
	statusBarChainIdKey: "",
	statusBarDisplayMode: "filenames",
	statusBarDotsCount: 7,
	chainBarVisible: true,
	chainBarPosition: "center",
	chains: [DEFAULT_CHAIN],
	linearWorkspaces: [],
	linearSyncOnOpen: true,
	linearSyncIntervalMinutes: 0,
	linearIssueFolder: "Linear",
};

class FileSuggest extends AbstractInputSuggest<TFile> {
	getSuggestions(inputStr: string): TFile[] {
		const lower = inputStr.toLowerCase();
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.toLowerCase().includes(lower))
			.slice(0, 20);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.setText(file.path);
	}

	selectSuggestion(file: TFile): void {
		this.setValue(file.path);
		this.close();
	}
}

export class TaskToolsSettingTab extends PluginSettingTab {
	plugin: TaskToolsPlugin;

	constructor(app: App, plugin: TaskToolsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const scrollEl = containerEl.closest(".vertical-tab-content") as HTMLElement | null;
		const scrollTop = scrollEl?.scrollTop ?? 0;
		containerEl.empty();

		// ── Task file detection ──────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Task file detection" });

		new Setting(containerEl)
			.setName("Frontmatter key")
			.setDesc("The frontmatter key used to identify a file as a task.")
			.addText((text) =>
				text
					.setPlaceholder("type")
					.setValue(this.plugin.settings.taskFrontmatterKey)
					.onChange(async (value) => {
						this.plugin.settings.taskFrontmatterKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Frontmatter value")
			.setDesc(
				"Only files where the key equals this value are treated as tasks. Leave empty to match any file that has the key."
			)
			.addText((text) =>
				text
					.setPlaceholder("task")
					.setValue(this.plugin.settings.taskFrontmatterValue)
					.onChange(async (value) => {
						this.plugin.settings.taskFrontmatterValue = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Task folder")
			.setDesc("Folder where new task files are created. Leave empty for vault root.")
			.addText((text) =>
				text
					.setPlaceholder("Tasks")
					.setValue(this.plugin.settings.taskFolder)
					.onChange(async (value) => {
						this.plugin.settings.taskFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Task template")
			.setDesc(
				"Optional template file. Its content is used as the body of new tasks; its frontmatter is merged with chain frontmatter (plugin keys take precedence)."
			)
			.addText((text) => {
				new FileSuggest(this.app, text.inputEl);
				text
					.setPlaceholder("Templates/task-template.md")
					.setValue(this.plugin.settings.taskTemplatePath)
					.onChange(async (value) => {
						this.plugin.settings.taskTemplatePath = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// ── Status bar ──────────────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Status bar" });

		let dotsCountSetting: Setting;

		new Setting(containerEl)
			.setName("Display mode")
			.setDesc("How items are shown in the status bar breadcrumb.")
			.addDropdown((drop) => {
				drop.addOption("filenames", "File names");
				drop.addOption("dots", "Dots");
				drop.setValue(this.plugin.settings.statusBarDisplayMode);
				drop.onChange(async (value) => {
					this.plugin.settings.statusBarDisplayMode = value as "filenames" | "dots";
					await this.plugin.saveSettings();
					dotsCountSetting.settingEl.toggle(value === "dots");
				});
			});

		dotsCountSetting = new Setting(containerEl)
			.setName("Visible dots")
			.setDesc("Maximum number of dots shown at once. The window stays centered on the current task.")
			.addSlider((slider) =>
				slider
					.setLimits(3, 15, 2)
					.setValue(this.plugin.settings.statusBarDotsCount)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.statusBarDotsCount = value;
						await this.plugin.saveSettings();
					})
			);

		dotsCountSetting.settingEl.toggle(this.plugin.settings.statusBarDisplayMode === "dots");

		new Setting(containerEl)
			.setName("Chain bar position")
			.setDesc("Where the chain breadcrumb bar appears at the bottom of the screen.")
			.addDropdown((drop) => {
				drop.addOption("left", "Left");
				drop.addOption("center", "Center");
				drop.addOption("right", "Right (next to status bar)");
				drop.setValue(this.plugin.settings.chainBarPosition);
				drop.onChange(async (value) => {
					this.plugin.settings.chainBarPosition = value as ChainBarPosition;
					await this.plugin.saveSettings();
				});
			});

		// ── Chain schemas ────────────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Chain schemas" });
		containerEl.createEl("p", {
			text: "Each schema defines a set of frontmatter keys for one chain type. A note participates in a chain by having that schema's keys in its frontmatter.",
			cls: "setting-item-description",
		});

		this.plugin.settings.chains.forEach((chain, idx) => {
			this.renderChainSchema(containerEl, chain, idx);
		});

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("Add chain schema")
				.setCta()
				.onClick(async () => {
					const newName = "New Chain";
					this.plugin.settings.chains.push({
						name: newName,
						...derivedChainKeys(slugifyChainName(newName)),
						currentStatusValue: "current",
						completedStatusValue: "done",
						readyStatusValue: "ready",
					});
					await this.plugin.saveSettings();
					this.display();
				})
		);

		// ── Linear integration ───────────────────────────────────────────────
		this.renderLinearSettings(containerEl);

		if (scrollEl) scrollEl.scrollTop = scrollTop;
	}

	private renderChainSchema(
		containerEl: HTMLElement,
		chain: ChainDefinition,
		idx: number
	): void {
		const section = containerEl.createEl("div", { cls: "chain-schema-section" });

		const headerEl = section.createEl("div", { cls: "chain-schema-header" });
		const h3 = headerEl.createEl("h3", { text: chain.name || `Chain ${idx + 1}` });

		const removeBtn = headerEl.createEl("button", {
			text: "Remove",
			cls: "chain-schema-remove-btn",
		});
		removeBtn.addEventListener("click", async () => {
			this.plugin.settings.chains.splice(idx, 1);
			await this.plugin.saveSettings();
			this.display();
		});

		// Refs to derived-key inputs so we can update them in-place when the name changes
		let idKeyInput: HTMLInputElement | null = null;
		let positionKeyInput: HTMLInputElement | null = null;
		let statusKeyInput: HTMLInputElement | null = null;

		const make = (name: string, desc: string, key: keyof ChainDefinition, placeholder: string) => {
			let inputRef: HTMLInputElement | null = null;
			new Setting(section)
				.setName(name)
				.setDesc(desc)
				.addText((text) => {
					text
						.setPlaceholder(placeholder)
						.setValue((chain[key] as string | undefined) ?? "")
						.onChange(async (value) => {
							(this.plugin.settings.chains[idx] as unknown as Record<string, string | undefined>)[key] =
								value.trim() || undefined;
							await this.plugin.saveSettings();
						});
					inputRef = text.inputEl;
				});
			if (key === "idKey") idKeyInput = inputRef;
			else if (key === "positionKey") positionKeyInput = inputRef;
			else if (key === "statusKey") statusKeyInput = inputRef;
		};

		// Name field: auto-derives idKey/positionKey/statusKey unless they've been manually changed
		new Setting(section)
			.setName("Name")
			.setDesc("Display name for this chain schema.")
			.addText((text) =>
				text
					.setPlaceholder("My Chain")
					.setValue(chain.name ?? "")
					.onChange(async (value) => {
						const c = this.plugin.settings.chains[idx];
						if (!c) return;
						const oldSlug = slugifyChainName(c.name ?? "");
						const oldDerived = derivedChainKeys(oldSlug);
						const newSlug = slugifyChainName(value);
						const newDerived = derivedChainKeys(newSlug);
						// Auto-update each key only if it still matches the old derived value; update inputs in-place
						if (c.idKey === oldDerived.idKey) {
							c.idKey = newDerived.idKey;
							if (idKeyInput) idKeyInput.value = newDerived.idKey;
						}
						if (c.positionKey === oldDerived.positionKey) {
							c.positionKey = newDerived.positionKey;
							if (positionKeyInput) positionKeyInput.value = newDerived.positionKey;
						}
						if (c.statusKey === oldDerived.statusKey) {
							c.statusKey = newDerived.statusKey;
							if (statusKeyInput) statusKeyInput.value = newDerived.statusKey;
						}
						c.name = value.trim() || "New Chain";
						// Update header in-place — no full re-render needed
						h3.setText(c.name);
						await this.plugin.saveSettings();
					})
			);
		make("ID key", "Frontmatter key that holds the chain identifier.", "idKey", "chain");
		make("Position key", "Frontmatter key for the numeric position within the chain.", "positionKey", "chain-position");
		make("Status key", "Frontmatter key for the task's status within this chain.", "statusKey", "chain-status");
		make("Current status value", "The value that marks a task as current in this chain.", "currentStatusValue", "current");
		make("Completed status value", "The value written to a task's status key when it is marked done.", "completedStatusValue", "done");

		section.createEl("p", {
			text: "Item creation (optional) — overrides global task settings when creating new items via this chain.",
			cls: "setting-item-description",
		});
		make("Item folder", "Folder where new items are created. Leave empty to use the vault root.", "itemFolder", "Issues");
		make("Item template", "Template file path for new items. Leave empty to use the global task template.", "itemTemplatePath", "Templates/issue-template.md");
		make("Item frontmatter key", "Frontmatter key added to new items (e.g. type). Leave empty to use the global setting.", "itemFrontmatterKey", "type");
		make("Item frontmatter value", "Value for the frontmatter key above (e.g. issue).", "itemFrontmatterValue", "issue");

		section.createEl("p", {
			text: "Completion routing (optional) — when set, advancing past a task in this chain automatically appends it to the target chain.",
			cls: "setting-item-description",
		});

		new Setting(section)
			.setName("Completion chain")
			.setDesc("The ID key of another chain schema to append completed tasks to. Leave empty to disable.")
			.addDropdown((drop) => {
				drop.addOption("", "— none —");
				for (const other of this.plugin.settings.chains) {
					if (other.idKey !== chain.idKey) {
						drop.addOption(other.idKey, `${other.name} (${other.idKey})`);
					}
				}
				drop.setValue(chain.completionChainIdKey ?? "");
				drop.onChange(async (value) => {
					const c = this.plugin.settings.chains[idx];
					if (c) c.completionChainIdKey = value || undefined;
					await this.plugin.saveSettings();
				});
			});

		// ── Linear workspace binding ─────────────────────────────────────────
		section.createEl("p", {
			text: "Linear (optional) — bind this chain to a specific Linear workspace. The Linear panel will default to that workspace when this chain is active.",
			cls: "setting-item-description",
		});

		new Setting(section)
			.setName("Linear workspace")
			.setDesc("Restrict this chain's Linear panel to one workspace, or leave unset to allow mixed workspaces.")
			.addDropdown((drop) => {
				drop.addOption("", "— any workspace —");
				for (const ws of this.plugin.settings.linearWorkspaces) {
					drop.addOption(ws.id, ws.name);
				}
				drop.setValue(chain.linearWorkspaceId ?? "");
				drop.onChange(async (value) => {
					const c = this.plugin.settings.chains[idx];
					if (c) c.linearWorkspaceId = value || undefined;
					await this.plugin.saveSettings();
				});
			});

		// ── Auto-populate ────────────────────────────────────────────────────
		section.createEl("p", {
			text: "Auto-populate (optional) — automatically add vault files that match frontmatter rules to this chain. Run via the 'Auto-populate chains' command.",
			cls: "setting-item-description",
		});

		new Setting(section)
			.setName("Auto-populate enabled")
			.setDesc("When enabled, the 'Auto-populate chains' command will scan the vault and add matching files to this chain.")
			.addToggle((toggle) =>
				toggle.setValue(chain.autoPopulateEnabled ?? false).onChange(async (value) => {
					const c = this.plugin.settings.chains[idx];
					if (c) c.autoPopulateEnabled = value || undefined;
					await this.plugin.saveSettings();
				})
			);

		this.renderRuleList(
			section,
			idx,
			"Include rules",
			"Files must match ALL of these rules to be added. At least one rule is required.",
			"autoPopulateInclude"
		);

		this.renderRuleList(
			section,
			idx,
			"Exclude rules",
			"Files matching ANY of these rules are skipped even if they match include rules.",
			"autoPopulateExclude"
		);
	}

	private renderRuleList(
		containerEl: HTMLElement,
		chainIdx: number,
		label: string,
		desc: string,
		field: "autoPopulateInclude" | "autoPopulateExclude"
	): void {
		const chain = this.plugin.settings.chains[chainIdx];
		if (!chain) return;

		const rules: FrontmatterRule[] = chain[field] ?? [];

		const wrapper = containerEl.createEl("div", { cls: "chain-rule-list" });
		wrapper.createEl("p", { text: label, cls: "setting-item-name" });
		wrapper.createEl("p", { text: desc, cls: "setting-item-description" });

		const listEl = wrapper.createEl("div", { cls: "chain-rule-rows" });

		const refresh = () => {
			listEl.empty();
			const currentRules: FrontmatterRule[] = this.plugin.settings.chains[chainIdx]?.[field] ?? [];
			currentRules.forEach((rule, ruleIdx) => {
				const row = listEl.createEl("div", { cls: "chain-rule-row" });

				const keyInput = row.createEl("input", {
					type: "text",
					placeholder: "frontmatter key",
					cls: "chain-rule-input",
				});
				keyInput.value = rule.key;
				keyInput.addEventListener("change", async () => {
					const c = this.plugin.settings.chains[chainIdx];
					if (c) {
						if (!c[field]) c[field] = [];
						c[field]![ruleIdx]!.key = keyInput.value.trim();
						await this.plugin.saveSettings();
					}
				});

				const valInput = row.createEl("input", {
					type: "text",
					placeholder: "value (empty = key exists)",
					cls: "chain-rule-input",
				});
				valInput.value = rule.value ?? "";
				valInput.addEventListener("change", async () => {
					const c = this.plugin.settings.chains[chainIdx];
					if (c) {
						if (!c[field]) c[field] = [];
						const trimmed = valInput.value.trim();
						c[field]![ruleIdx]!.value = trimmed || undefined;
						await this.plugin.saveSettings();
					}
				});

				const removeBtn = row.createEl("button", { text: "×", cls: "chain-rule-remove" });
				removeBtn.setAttribute("aria-label", "Remove rule");
				removeBtn.addEventListener("click", async () => {
					const c = this.plugin.settings.chains[chainIdx];
					if (c) {
						c[field] = (c[field] ?? []).filter((_, i) => i !== ruleIdx);
						await this.plugin.saveSettings();
						refresh();
					}
				});
			});
		};

		refresh();

		const addBtn = wrapper.createEl("button", { text: "+ Add rule", cls: "chain-rule-add" });
		addBtn.addEventListener("click", async () => {
			const c = this.plugin.settings.chains[chainIdx];
			if (c) {
				if (!c[field]) c[field] = [];
				c[field]!.push({ key: "" });
				await this.plugin.saveSettings();
				refresh();
			}
		});
	}

	// ── Linear settings ──────────────────────────────────────────────────────

	private renderLinearSettings(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Linear integration" });

		// Issue folder
		new Setting(containerEl)
			.setName("Issue folder")
			.setDesc("Folder where imported Linear issues are created.")
			.addText((text) =>
				text
					.setPlaceholder("Linear")
					.setValue(this.plugin.settings.linearIssueFolder)
					.onChange(async (value) => {
						this.plugin.settings.linearIssueFolder = value.trim() || "Linear";
						await this.plugin.saveSettings();
					})
			);

		// Sync on open
		new Setting(containerEl)
			.setName("Sync on open")
			.setDesc("Pull status updates from Linear when Obsidian opens.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.linearSyncOnOpen).onChange(async (value) => {
					this.plugin.settings.linearSyncOnOpen = value;
					await this.plugin.saveSettings();
				})
			);

		// Sync interval
		new Setting(containerEl)
			.setName("Auto-sync interval (minutes)")
			.setDesc("Poll Linear for updates on this interval. Set to 0 to disable.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 120, 15)
					.setValue(this.plugin.settings.linearSyncIntervalMinutes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.linearSyncIntervalMinutes = value;
						await this.plugin.saveSettings();
						this.plugin.rescheduleLinearSync();
					})
			);

		containerEl.createEl("h3", { text: "Workspaces" });
		containerEl.createEl("p", {
			text: "Each workspace connects to one Linear organization. You can use a Personal API key (paste from Linear → Settings → API) or OAuth.",
			cls: "setting-item-description",
		});

		const wsContainer = containerEl.createDiv({ cls: "linear-workspace-list" });
		this.renderWorkspaceList(wsContainer);

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("Add workspace")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.linearWorkspaces.push({
						id: `workspace-${Date.now()}`,
						name: "New Workspace",
						authType: "apiKey",
					});
					await this.plugin.saveSettings();
					this.display();
				})
		);
	}

	private renderWorkspaceList(container: HTMLElement): void {
		container.empty();
		const workspaces = this.plugin.settings.linearWorkspaces;

		if (workspaces.length === 0) {
			container.createEl("p", {
				cls: "setting-item-description",
				text: "No workspaces configured yet.",
			});
			return;
		}

		workspaces.forEach((ws, idx) => {
			const section = container.createDiv({ cls: "linear-workspace-section" });

			const header = section.createDiv({ cls: "chain-schema-header" });
			header.createEl("h4", { text: ws.name || `Workspace ${idx + 1}` });
			const removeBtn = header.createEl("button", { text: "Remove", cls: "chain-schema-remove-btn" });
			removeBtn.addEventListener("click", async () => {
				this.plugin.settings.linearWorkspaces.splice(idx, 1);
				await this.plugin.saveSettings();
				this.plugin.linearManager?.refreshClients();
				this.display();
			});

			// Workspace ID
			new Setting(section)
				.setName("ID")
				.setDesc("Short slug used as the frontmatter key (e.g. \"acme\"). Cannot be changed after importing issues.")
				.addText((text) =>
					text
						.setPlaceholder("acme")
						.setValue(ws.id)
						.onChange(async (value) => {
							this.plugin.settings.linearWorkspaces[idx]!.id = value.trim() || ws.id;
							await this.plugin.saveSettings();
						})
				);

			// Display name
			new Setting(section)
				.setName("Name")
				.setDesc("Display name shown in the Linear panel.")
				.addText((text) =>
					text
						.setPlaceholder("Acme Corp")
						.setValue(ws.name)
						.onChange(async (value) => {
							this.plugin.settings.linearWorkspaces[idx]!.name = value.trim() || "Workspace";
							await this.plugin.saveSettings();
						})
				);

			// Auth type
			new Setting(section)
				.setName("Auth type")
				.setDesc("How to authenticate with this workspace.")
				.addDropdown((drop) => {
					drop.addOption("apiKey", "Personal API key");
					drop.addOption("oauth", "OAuth");
					drop.setValue(ws.authType);
					drop.onChange(async (value) => {
						this.plugin.settings.linearWorkspaces[idx]!.authType = value as "apiKey" | "oauth";
						await this.plugin.saveSettings();
						this.plugin.linearManager?.refreshClients();
						this.display();
					});
				});

			if (ws.authType === "apiKey") {
				new Setting(section)
					.setName("API key")
					.setDesc("Personal API key from Linear → Settings → API.")
					.addText((text) => {
						text.inputEl.type = "password";
						text
							.setPlaceholder("lin_api_…")
							.setValue(ws.apiKey ?? "")
							.onChange(async (value) => {
								this.plugin.settings.linearWorkspaces[idx]!.apiKey = value.trim() || undefined;
								await this.plugin.saveSettings();
								this.plugin.linearManager?.refreshClients();
							});
					});
			} else {
				// OAuth
				const oauthSetting = new Setting(section)
					.setName("OAuth")
					.setDesc(
						ws.oauthToken
							? "Connected. Click to reconnect."
							: "Not connected. Click to start the OAuth flow."
					);
				oauthSetting.addButton((btn) => {
					btn.setButtonText(ws.oauthToken ? "Reconnect" : "Connect with Linear");
					if (ws.oauthToken) btn.setWarning();
					else btn.setCta();
					btn.onClick(() => {
						this.plugin.startLinearOAuth(ws.id);
					});
				});
				if (ws.oauthToken) {
					oauthSetting.addButton((btn) =>
						btn
							.setButtonText("Disconnect")
							.setWarning()
							.onClick(async () => {
								this.plugin.settings.linearWorkspaces[idx]!.oauthToken = undefined;
								this.plugin.settings.linearWorkspaces[idx]!.oauthRefreshToken = undefined;
								await this.plugin.saveSettings();
								this.plugin.linearManager?.refreshClients();
								this.display();
							})
					);
				}
			}

			// Verify connection button
			new Setting(section).addButton((btn) =>
				btn
					.setButtonText("Test connection")
					.onClick(async () => {
						const client = this.plugin.linearManager?.getClient(ws.id);
						if (!client) {
							new (await import("obsidian")).Notice(
								"No credentials configured for this workspace."
							);
							return;
						}
						try {
							const name = await client.getOrganizationName();
							new (await import("obsidian")).Notice(`Connected to "${name}" ✓`);
						} catch (err) {
							new (await import("obsidian")).Notice(`Connection failed: ${String(err)}`);
						}
					})
			);
		});
	}
}
