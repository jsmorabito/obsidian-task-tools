import { SuggestModal } from "obsidian";
import type { App } from "obsidian";
import type { ChainDefinition } from "./types";

/**
 * A fuzzy-search modal over a list of ChainDefinitions.
 * Resolves with the selected chain via the onChoose callback.
 */
export class ChainSuggestModal extends SuggestModal<ChainDefinition> {
	private chains: ChainDefinition[];
	private onChoose: (chain: ChainDefinition) => void;

	constructor(
		app: App,
		chains: ChainDefinition[],
		onChoose: (chain: ChainDefinition) => void
	) {
		super(app);
		this.chains = chains;
		this.onChoose = onChoose;
		this.setPlaceholder("Select a chain…");
	}

	getSuggestions(query: string): ChainDefinition[] {
		const lower = query.toLowerCase();
		if (!lower) return this.chains;
		return this.chains.filter((c) => c.name.toLowerCase().includes(lower));
	}

	renderSuggestion(chain: ChainDefinition, el: HTMLElement): void {
		el.createEl("div", { text: chain.name, cls: "chain-suggest-name" });
		el.createEl("small", {
			text: `id key: ${chain.idKey}`,
			cls: "chain-suggest-detail",
		});
	}

	onChooseSuggestion(chain: ChainDefinition): void {
		this.onChoose(chain);
	}
}
