import { SuggestModal } from "obsidian";
import type { App } from "obsidian";

interface ChainInstance {
	chainId: string;
	fileCount: number;
	/** true when this is the synthetic "create new" entry */
	isNew?: boolean;
}

/**
 * A fuzzy-search modal that lists existing chain instances (by chainId value)
 * for a given schema, plus a "Add to new group…" option that lets the user type a
 * fresh ID.  The callback receives the chosen / entered chainId string.
 */
export class ChainInstanceSuggestModal extends SuggestModal<ChainInstance> {
	private instances: ChainInstance[];
	private defaultNewId: string;
	private onChoose: (chainId: string) => void;

	constructor(
		app: App,
		instances: { chainId: string; fileCount: number }[],
		chainName: string,
		onChoose: (chainId: string) => void
	) {
		super(app);
		this.instances = instances;
		this.onChoose = onChoose;

		// Derive a sensible default ID from the chain name (e.g. "LLM Plugin issue chain" → "llm-plugin-issue-chain")
		this.defaultNewId = chainName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "");

		if (instances.length === 0) {
			this.setPlaceholder(`No groups yet — type an ID or press Enter to create "${this.defaultNewId}"`);
		} else {
			this.setPlaceholder("Choose an existing group, or type a new ID…");
		}
	}

	getSuggestions(query: string): ChainInstance[] {
		const lower = query.toLowerCase().trim();

		const filtered = lower
			? this.instances.filter((i) =>
					i.chainId.toLowerCase().includes(lower)
			  )
			: [...this.instances];

		// The "create new" entry uses the typed query, or the default if nothing is typed
		const newId = query.trim() || this.defaultNewId;
		const newEntry: ChainInstance = {
			chainId: newId,
			fileCount: 0,
			isNew: true,
		};

		return [...filtered, newEntry];
	}

	renderSuggestion(item: ChainInstance, el: HTMLElement): void {
		if (item.isNew) {
			el.createEl("div", {
				text: `＋ Add to new group "${item.chainId}"`,
				cls: "chain-instance-new",
			});
		} else {
			el.createEl("div", {
				text: item.chainId,
				cls: "chain-instance-id",
			});
			el.createEl("small", {
				text: `${item.fileCount} file${item.fileCount !== 1 ? "s" : ""}`,
				cls: "chain-instance-count",
			});
		}
	}

	onChooseSuggestion(item: ChainInstance): void {
		this.onChoose(item.chainId);
	}
}
