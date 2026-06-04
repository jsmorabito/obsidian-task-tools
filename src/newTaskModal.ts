import {
	App,
	Modal,
	Notice,
	Setting,
	TFile,
	normalizePath,
	parseYaml,
	stringifyYaml,
} from "obsidian";
import type TaskToolsPlugin from "./main";
import type { ChainDefinition } from "./types";

interface ChainEnrollment {
	enabled: boolean;
	chainId: string;
	position: number;
	setCurrent: boolean;
}

export class NewTaskModal extends Modal {
	plugin: TaskToolsPlugin;
	private taskName: string = "";
	private enrollments: Map<string, ChainEnrollment> = new Map();
	private preselectedChain: ChainDefinition | null;
	/** User-chosen template path; null means use the auto-resolved default. */
	private templatePathOverride: string | null = null;

	constructor(app: App, plugin: TaskToolsPlugin, preselectedChain?: ChainDefinition) {
		super(app);
		this.plugin = plugin;
		this.preselectedChain = preselectedChain ?? null;

		for (const chain of plugin.settings.chains) {
			this.enrollments.set(chain.idKey, {
				enabled: preselectedChain?.idKey === chain.idKey,
				chainId: "",
				position: 1,
				setCurrent: false,
			});
		}
	}

	/** Returns files from the Obsidian Templates / Templater folder, or all markdown files. */
	private getTemplateFiles(): TFile[] {
		const app = this.app as unknown as {
			internalPlugins?: { plugins?: Record<string, { instance?: { options?: { folder?: string } } }> };
			plugins?: { plugins?: Record<string, { settings?: { templates_folder?: string } }> };
		};
		const coreFolder = app.internalPlugins?.plugins?.["templates"]?.instance?.options?.folder;
		const templaterFolder = app.plugins?.plugins?.["templater-obsidian"]?.settings?.templates_folder;
		const folder = coreFolder ?? templaterFolder ?? null;
		const all = this.app.vault.getMarkdownFiles();
		if (!folder) return all;
		const prefix = folder.endsWith("/") ? folder : folder + "/";
		return all.filter((f) => f.path.startsWith(prefix));
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("new-task-modal");

		const title = this.preselectedChain ? "New chain item" : "New task";
		contentEl.createEl("h2", { text: title });

		const itemLabel = this.preselectedChain ? "Item name" : "Task name";
		new Setting(contentEl)
			.setName(itemLabel)
			.setDesc("Becomes the filename (without .md).")
			.addText((text) => {
				text.setPlaceholder(this.preselectedChain ? "My item" : "My task").onChange((value) => {
					this.taskName = value.trim();
				});
				setTimeout(() => text.inputEl.focus(), 0);
			});

		// Template dropdown — lists files from the configured templates folder
		const templateFiles = this.getTemplateFiles();
		const resolvedDefault = this.resolveCreationConfig().templatePath;
		new Setting(contentEl)
			.setName("Template")
			.addDropdown((dd) => {
				dd.addOption("", resolvedDefault ? `Default (${resolvedDefault.split("/").pop()})` : "None");
				for (const f of templateFiles) {
					dd.addOption(f.path, f.basename);
				}
				dd.setValue(this.templatePathOverride ?? "");
				dd.onChange((v) => { this.templatePathOverride = v || null; });
			});

		contentEl.createEl("h3", { text: "Add to chains" });

		for (const chain of this.plugin.settings.chains) {
			this.renderChainEnrollment(contentEl, chain);
		}

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText(this.preselectedChain ? "Create item" : "Create task")
				.setCta()
				.onClick(() => void this.submit())
		);

		contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				void this.submit();
			}
		});
	}

	private renderChainEnrollment(containerEl: HTMLElement, chain: ChainDefinition): void {
		const enrollment = this.enrollments.get(chain.idKey)!;
		const section = containerEl.createEl("div", { cls: "new-task-chain-section" });

		const toggleSetting = new Setting(section)
			.setName(chain.name)
			.addToggle((toggle) =>
				toggle.setValue(enrollment.enabled).onChange((value) => {
					enrollment.enabled = value;
					detailEl.style.display = value ? "block" : "none";
				})
			);
		toggleSetting.settingEl.addClass("new-task-chain-toggle");

		const detailEl = section.createEl("div", { cls: "new-task-chain-detail" });
		detailEl.style.display = enrollment.enabled ? "block" : "none";

		// Auto-set chain ID and position from existing data
		const existingIds = this.getExistingChainIds(chain);
		enrollment.chainId = existingIds[0] ?? "";
		enrollment.position = this.getNextPosition(chain, enrollment.chainId);

		new Setting(detailEl)
			.setName("Set as current")
			.setDesc("Mark this task as the current one in this chain immediately.")
			.addToggle((toggle) =>
				toggle.setValue(false).onChange((value) => {
					enrollment.setCurrent = value;
				})
			);
	}

	/** Returns distinct chain IDs in use for the given schema, using the plugin's index. */
	private getExistingChainIds(chain: ChainDefinition): string[] {
		const ids = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
			const id = fm?.[chain.idKey];
			if (id != null) ids.add(String(id as string | number | boolean));
		}
		return Array.from(ids).sort();
	}

	/** Returns max position + 1 for the given chain, using the plugin's index. */
	private getNextPosition(chain: ChainDefinition, chainId: string): number {
		if (!chainId) return 1;
		const peers = this.plugin.getPeerFiles(chain, chainId);
		let max = 0;
		for (const file of peers) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const pos = Number(fm?.[chain.positionKey]);
			if (!isNaN(pos) && pos > max) max = pos;
		}
		return max + 1;
	}

	/**
	 * Resolve which folder/template/frontmatter key to use for this new item.
	 * If exactly one enrolled chain defines its own creation config, use it.
	 * Otherwise fall back to global task settings.
	 */
	private resolveCreationConfig(): {
		folder: string;
		templatePath: string;
		fmKey: string;
		fmValue: string;
	} {
		const enrolledWithConfig = this.plugin.settings.chains.filter((c) => {
			const e = this.enrollments.get(c.idKey);
			return (
				e?.enabled &&
				e.chainId &&
				(c.itemFolder !== undefined ||
					c.itemTemplatePath !== undefined ||
					c.itemFrontmatterKey !== undefined)
			);
		});

		const source =
			enrolledWithConfig.length === 1 ? enrolledWithConfig[0] : null;

		return {
			folder: source?.itemFolder ?? this.plugin.settings.taskFolder,
			templatePath: source?.itemTemplatePath ?? this.plugin.settings.taskTemplatePath,
			fmKey: source?.itemFrontmatterKey ?? this.plugin.settings.taskFrontmatterKey,
			fmValue: source?.itemFrontmatterValue ?? this.plugin.settings.taskFrontmatterValue,
		};
	}

	private async submit(): Promise<void> {
		if (!this.taskName) {
			new Notice("Task name is required.");
			return;
		}

		const pluginFm: Record<string, unknown> = {};

		const resolved = this.resolveCreationConfig();
		const { fmKey, fmValue, folder: rawFolder } = resolved;
		const templatePath = this.templatePathOverride ?? resolved.templatePath;
		if (fmKey) {
			pluginFm[fmKey] = fmValue || true;
		}

		const activeEnrollments: Array<{ chain: ChainDefinition; enrollment: ChainEnrollment }> = [];

		for (const chain of this.plugin.settings.chains) {
			const enrollment = this.enrollments.get(chain.idKey);
			if (!enrollment?.enabled || !enrollment.chainId) continue;

			pluginFm[chain.idKey] = enrollment.chainId;
			pluginFm[chain.positionKey] = enrollment.position;
			if (enrollment.setCurrent) {
				pluginFm[chain.statusKey] = chain.currentStatusValue;
			}
			activeEnrollments.push({ chain, enrollment });
		}

		const content = await this.buildContent(pluginFm, templatePath);

		const folder = rawFolder ? normalizePath(rawFolder) : "";
		const fileName = `${this.taskName}.md`;
		const filePath = folder ? `${folder}/${fileName}` : fileName;

		try {
			if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
				await this.app.vault.createFolder(folder);
			}

			const file = await this.app.vault.create(filePath, content);

			for (const { chain, enrollment } of activeEnrollments) {
				if (enrollment.setCurrent) {
					await this.plugin.setCurrentTask(file, chain);
				}
			}

			const leaf = this.app.workspace.getMostRecentLeaf();
			if (leaf) await leaf.openFile(file);

			this.close();
		} catch (e) {
			new Notice(`Failed to create task: ${(e as Error).message}`);
		}
	}

	/**
	 * Build the full file content for the new item.
	 * Template frontmatter (if set) is the base; plugin keys are merged on top.
	 * Uses Obsidian's parseYaml/stringifyYaml for correct YAML handling.
	 * {{title}} in the template body is replaced with the item name.
	 */
	private async buildContent(pluginFm: Record<string, unknown>, templatePath: string): Promise<string> {
		if (templatePath) {
			const templateFile = this.app.vault.getFileByPath(templatePath);
			if (templateFile) {
				const raw = await this.app.vault.read(templateFile);
				const { templateFm, body } = this.parseTemplate(raw);
				const merged = { ...templateFm, ...pluginFm };
				const resolvedBody = body.replace(/\{\{title\}\}/gi, this.taskName);
				return `---\n${stringifyYaml(merged)}---\n${resolvedBody}`;
			}
		}

		return `---\n${stringifyYaml(pluginFm)}---\n\n# ${this.taskName}\n`;
	}

	/** Split raw file text into a parsed frontmatter object and body string. */
	private parseTemplate(raw: string): { templateFm: Record<string, unknown>; body: string } {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
		if (!match) return { templateFm: {}, body: raw };

		const fmBlock = match[1] ?? "";
		const body = match[2] ?? "";

		let templateFm: Record<string, unknown> = {};
		try {
			const parsed: unknown = parseYaml(fmBlock);
			if (parsed && typeof parsed === "object") {
				templateFm = parsed as Record<string, unknown>;
			}
		} catch {
			// Malformed template frontmatter — proceed with empty base
		}

		return { templateFm, body };
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
