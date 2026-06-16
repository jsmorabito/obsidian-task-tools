import { Component, MarkdownPostProcessorContext, TFile } from "obsidian";
import TaskToolsPlugin from "./main";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CheckboxStatus {
	mark: string;
	icon: string; // fallback text icon for custom marks not in MARK_TO_SVG_CATEGORY
	label: string;
}

// ── SVG icons (designed for Task Genius, using currentColor) ─────────────────

const STATUS_SVGS: Record<string, string> = {
	notStarted: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19 3H5C3.89543 3 3 3.89543 3 5V19C3 20.1046 3.89543 21 5 21H19C20.1046 21 21 20.1046 21 19V5C21 3.89543 20.1046 3 19 3Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 4"/></svg>`,
	planned:    `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19 3H5C3.89543 3 3 3.89543 3 5V19C3 20.1046 3.89543 21 5 21H19C20.1046 21 21 20.1046 21 19V5C21 3.89543 20.1046 3 19 3Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	inProgress: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19 3H5C3.89543 3 3 3.89543 3 5V19C3 20.1046 3.89543 21 5 21H19C20.1046 21 21 20.1046 21 19V5C21 3.89543 20.1046 3 19 3Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 6H17C17.5523 6 18 6.44772 18 7V17C18 17.5523 17.5523 18 17 18H12V6Z" fill="currentColor"/></svg>`,
	completed:  `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19 2C20.6569 2 22 3.34315 22 5V19C22 20.6569 20.6569 22 19 22H5C3.34315 22 2 20.6569 2 19V5C2 3.34315 3.34315 2 5 2H19ZM15.707 9.29297C15.3409 8.92685 14.7619 8.90426 14.3691 9.22461L14.293 9.29297L11 12.5859L9.70703 11.293L9.63086 11.2246C9.23809 10.9043 8.65908 10.9269 8.29297 11.293C7.92685 11.6591 7.90426 12.2381 8.22461 12.6309L8.29297 12.707L10.293 14.707L10.3691 14.7754C10.7619 15.0957 11.3409 15.0731 11.707 14.707L15.707 10.707L15.7754 10.6309C16.0957 10.2381 16.0731 9.65908 15.707 9.29297Z" fill="currentColor"/></svg>`,
	abandoned:  `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19 2C20.6569 2 22 3.34315 22 5V19C22 20.6569 20.6569 22 19 22H5C3.34315 22 2 20.6569 2 19V5C2 3.34315 3.34315 2 5 2H19ZM15.707 8.29297C15.3165 7.90244 14.6835 7.90244 14.293 8.29297L12 10.5859L9.70703 8.29297L9.63086 8.22461C9.23809 7.90426 8.65908 7.92685 8.29297 8.29297C7.92685 8.65908 7.90426 9.23809 8.22461 9.63086L8.29297 9.70703L10.5859 12L8.29297 14.293C7.90244 14.6835 7.90244 15.3165 8.29297 15.707C8.68349 16.0976 9.31651 16.0976 9.70703 15.707L12 13.4141L14.293 15.707L14.3691 15.7754C14.7619 16.0957 15.3409 16.0731 15.707 15.707C16.0731 15.3409 16.0957 14.7619 15.7754 14.3691L15.707 14.293L13.4141 12L15.707 9.70703C16.0976 9.31651 16.0976 8.68349 15.707 8.29297Z" fill="currentColor"/></svg>`,
};

// Maps mark characters to icon categories. Any mark not listed falls back to
// the `icon` text field in the CheckboxStatus definition.
const MARK_TO_SVG_CATEGORY: Record<string, keyof typeof STATUS_SVGS> = {
	" ": "notStarted",
	"x": "completed",
	"X": "completed",
	"/": "inProgress",
	">": "inProgress",
	"-": "abandoned",
	"t": "planned",
	"?": "planned",
	"!": "planned",
};

// Half-filled circle SVG for "in progress" chain nodes.
// r=7 with stroke-width=1.5 makes the visual circle ~15px — matching the 16px CSS-border dots.
export const HALF_CIRCLE_SVG = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1"/><path d="M8 1 A7 7 0 0 1 8 15 Z" fill="currentColor"/></svg>`;

export const DEFAULT_CHECKBOX_STATUSES: CheckboxStatus[] = [
	{ mark: " ", icon: "", label: "Backlog" },
	{ mark: "t", icon: "", label: "Todo" },
	{ mark: "/", icon: "", label: "In Progress" },
	{ mark: "x", icon: "", label: "Done" },
	{ mark: "-", icon: "", label: "Cancelled" },
];

// ── Shared helpers (used by both reading-view and editor extension) ───────────

/** Returns the SVG string for a mark, or null if it maps to a custom icon. */
export function getSvgForMark(mark: string): string | null {
	const cat = MARK_TO_SVG_CATEGORY[mark];
	return cat ? (STATUS_SVGS[cat] ?? null) : null;
}

/** Builds the icon element for a mark, inserting SVG or falling back to text. */
export function buildIconEl(
	mark: string,
	statuses: CheckboxStatus[],
	extraCls?: string
): HTMLElement {
	const el = createEl("span", {
		cls: ["tt-checkbox-icon", ...(extraCls ? [extraCls] : [])].join(" "),
		attr: {
			"data-task-state": mark,
			role: "button",
			tabindex: "0",
		},
	});

	const status = statuses.find((s) => s.mark === mark);
	el.setAttribute("aria-label", status?.label ?? mark);

	const svg = getSvgForMark(mark);
	if (svg) {
		el.innerHTML = svg;
	} else {
		el.setText(status?.icon || mark);
	}

	return el;
}

// ── Reading-view post-processor ───────────────────────────────────────────────

export function applyCheckboxIcons(
	plugin: TaskToolsPlugin,
	element: HTMLElement,
	ctx: MarkdownPostProcessorContext
): void {
	const taskItems = element.findAll(".task-list-item");
	const seen = new Set<HTMLElement>();

	for (const item of taskItems) {
		if (item.querySelector(".tt-checkbox-icon") || seen.has(item)) continue;
		seen.add(item);

		const checkbox = item.querySelector(
			".task-list-item-checkbox"
		) as HTMLInputElement | null;
		if (!checkbox) continue;

		const mark = item.getAttribute("data-task") ?? " ";
		new CheckboxIcon(plugin, item, checkbox, mark, ctx).load();
	}
}

class CheckboxIcon extends Component {
	private iconEl: HTMLElement | null = null;

	constructor(
		private plugin: TaskToolsPlugin,
		private taskItem: HTMLElement,
		private checkbox: HTMLInputElement,
		private mark: string,
		private ctx: MarkdownPostProcessorContext
	) {
		super();
	}

	load(): this {
		const statuses = this.plugin.settings.checkboxStatuses ?? DEFAULT_CHECKBOX_STATUSES;
		this.iconEl = buildIconEl(this.mark, statuses);

		this.checkbox.parentElement?.insertBefore(
			this.iconEl,
			this.checkbox.nextSibling
		);
		this.checkbox.hide();

		this.registerDomEvent(this.iconEl, "click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.cycle();
		});

		this.registerDomEvent(this.iconEl, "keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				this.cycle();
			}
		});

		return this;
	}

	private refreshIcon(): void {
		if (!this.iconEl) return;
		const statuses = this.plugin.settings.checkboxStatuses ?? DEFAULT_CHECKBOX_STATUSES;
		const status = statuses.find((s) => s.mark === this.mark);

		this.iconEl.setAttribute("data-task-state", this.mark);
		this.iconEl.setAttribute("aria-label", status?.label ?? this.mark);

		const svg = getSvgForMark(this.mark);
		if (svg) {
			this.iconEl.innerHTML = svg;
		} else {
			this.iconEl.innerHTML = "";
			this.iconEl.setText(status?.icon || this.mark);
		}
	}

	private nextMark(): string {
		const statuses = this.plugin.settings.checkboxStatuses ?? DEFAULT_CHECKBOX_STATUSES;
		const cycle = statuses.map((s) => s.mark);
		if (cycle.length === 0) return this.mark;
		const idx = cycle.indexOf(this.mark);
		return cycle[(idx + 1) % cycle.length] ?? cycle[0] ?? this.mark;
	}

	private cycle(): void {
		const next = this.nextMark();
		const file = this.ctx.sourcePath
			? this.plugin.app.vault.getFileByPath(this.ctx.sourcePath)
			: null;
		if (!(file instanceof TFile)) return;

		const sectionInfo = this.ctx.getSectionInfo(this.taskItem);
		if (!sectionInfo) return;

		void this.plugin.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			const dataLine = parseInt(
				this.taskItem.getAttribute("data-line") ?? "0"
			);
			const lineIdx = sectionInfo.lineStart + dataLine;
			const line = lines[lineIdx];
			if (!line) return content;

			const updated = line.replace(/(\s*[-*+]\s*\[)(.)(])/, `$1${next}$3`);
			if (updated === line) return content;

			lines[lineIdx] = updated;

			// Optimistic UI update
			this.mark = next;
			this.taskItem.setAttribute("data-task", next);
			this.checkbox.checked = next === "x" || next === "X";
			this.refreshIcon();

			return lines.join("\n");
		});
	}

	unload(): void {
		this.iconEl?.remove();
		this.checkbox.show();
		super.unload();
	}
}
