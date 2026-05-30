import { AbstractInputSuggest, App, PluginSettingTab, Setting, TFile } from "obsidian";
import type { ChainDefinition, FrontmatterRule } from "./types";
import TaskToolsPlugin from "./main";

export type StatusBarDisplayMode = "filenames" | "dots";

export interface TaskToolsSettings {
	taskFrontmatterKey: string;
	taskFrontmatterValue: string;
	taskFolder: string;
	taskTemplatePath: string;
	statusBarChainIdKey: string; // idKey of the chain shown in the status bar
	statusBarDisplayMode: StatusBarDisplayMode;
	statusBarDotsCount: number; // max visible dots at a time
	chainBarVisible: boolean;
	chains: ChainDefinition[];
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
	return { idKey: slug, positionKey: `${slug}-position`, statusKey: `${slug}-status` };
}

export const DEFAULT_CHAIN: ChainDefinition = {
	name: "Project Chain",
	...derivedChainKeys(slugifyChainName("Project Chain")),
	currentStatusValue: "current",
	completedStatusValue: "done",
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
	chains: [DEFAULT_CHAIN],
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
					});
					await this.plugin.saveSettings();
					this.display();
				})
		);
	}

	private renderChainSchema(
		containerEl: HTMLElement,
		chain: ChainDefinition,
		idx: number
	): void {
		const section = containerEl.createEl("div", { cls: "chain-schema-section" });

		const headerEl = section.createEl("div", { cls: "chain-schema-header" });
		headerEl.createEl("h3", { text: chain.name || `Chain ${idx + 1}` });

		const removeBtn = headerEl.createEl("button", {
			text: "Remove",
			cls: "chain-schema-remove-btn",
		});
		removeBtn.addEventListener("click", async () => {
			this.plugin.settings.chains.splice(idx, 1);
			await this.plugin.saveSettings();
			this.display();
		});

		const make = (name: string, desc: string, key: keyof ChainDefinition, placeholder: string) => {
			new Setting(section)
				.setName(name)
				.setDesc(desc)
				.addText((text) =>
					text
						.setPlaceholder(placeholder)
						.setValue((chain[key] as string | undefined) ?? "")
						.onChange(async (value) => {
							(this.plugin.settings.chains[idx] as unknown as Record<string, string | undefined>)[key] =
								value.trim() || undefined;
							await this.plugin.saveSettings();
						})
				);
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
						// Auto-update each key only if it still matches the old derived value
						if (c.idKey === oldDerived.idKey) c.idKey = newDerived.idKey;
						if (c.positionKey === oldDerived.positionKey) c.positionKey = newDerived.positionKey;
						if (c.statusKey === oldDerived.statusKey) c.statusKey = newDerived.statusKey;
						c.name = value.trim() || "New Chain";
						await this.plugin.saveSettings();
						this.display();
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
}
