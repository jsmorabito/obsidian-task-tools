import {
	Decoration,
	DecorationSet,
	EditorView,
	keymap,
	MatchDecorator,
	PluginSpec,
	PluginValue,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { Annotation, EditorSelection, Prec } from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
// @ts-ignore
import { syntaxTree, tokenClassNodeProp } from "@codemirror/language";

import TaskToolsPlugin from "./main";
import { buildIconEl, CheckboxStatus, DEFAULT_CHECKBOX_STATUSES } from "./checkboxIcons";

export const checkboxCycleAnnotation = Annotation.define<string>();

// ── Widget ────────────────────────────────────────────────────────────────────

class CheckboxIconWidget extends WidgetType {
	private readonly isLivePreview: boolean;
	private readonly bulletText: string;

	constructor(
		private readonly plugin: TaskToolsPlugin,
		private readonly view: EditorView,
		private readonly from: number,
		private readonly to: number,
		private readonly mark: string,
		private readonly listPrefix: string
	) {
		super();
		this.isLivePreview = view.state.field(editorLivePreviewField);
		this.bulletText = listPrefix.trim();
	}

	eq(other: CheckboxIconWidget): boolean {
		return (
			this.from === other.from &&
			this.to === other.to &&
			this.mark === other.mark &&
			this.bulletText === other.bulletText
		);
	}

	toDOM(): HTMLElement {
		const statuses = this.plugin.settings.checkboxStatuses ?? DEFAULT_CHECKBOX_STATUSES;

		const iconEl = buildIconEl(this.mark, statuses, "tt-checkbox-icon--editor");
		iconEl.setAttribute(
			"aria-label",
			`Status: ${statuses.find((s) => s.mark === this.mark)?.label ?? this.mark} — click to cycle`
		);

		iconEl.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.cycleToNext();
		});

		return iconEl;
	}

	// Default ignoreEvent() returns true — the editor ignores events inside the
	// widget so it won't move the cursor on click. Our DOM listener handles it.

	private getStatuses(): CheckboxStatus[] {
		return this.plugin.settings.checkboxStatuses ?? DEFAULT_CHECKBOX_STATUSES;
	}

	private cycleToNext(): void {
		const statuses = this.getStatuses();
		const marks = statuses.map((s) => s.mark);
		const idx = marks.indexOf(this.mark);
		const next = marks[(idx + 1) % marks.length] ?? marks[0] ?? " ";

		const current = this.view.state.doc.sliceString(this.from, this.to);
		const updated = current.replace(/\[(.)]/,  `[${next}]`);

		// Place cursor just AFTER the replaced range so it doesn't land inside
		// the decoration and immediately collapse it back to raw text.
		this.view.dispatch({
			changes: { from: this.from, to: this.to, insert: updated },
			annotations: checkboxCycleAnnotation.of("cycle"),
			selection: EditorSelection.cursor(this.to + 1),
		});
	}
}

// ── ViewPlugin ────────────────────────────────────────────────────────────────

export function checkboxIconsEditorExtension(plugin: TaskToolsPlugin) {
	// Regex matches a full task-list line start (no `m` flag — MatchDecorator
	// processes line-by-line so `^` works correctly without it):
	//   group 1 = indentation
	//   group 2 = bullet + space  ("- " / "* " / "1. " etc.)
	//   group 3 = checkbox + space  ("[x] ")
	//   group 4 = the mark character
	const TASK_RE = /^(\s*)((?:[-*+]|\d+[.)])\s)(\[(.)]\s)/g;

	class CheckboxIconsPlugin implements PluginValue {
		decorations: DecorationSet = Decoration.none;
		view: EditorView;

		private readonly match = new MatchDecorator({
			regexp: TASK_RE,
			decorate: (add, from, to, match, view) => {
				if (!this.shouldRender(view, from, to)) return;

				const mark           = match[4]!;
				const bulletWithSp   = match[2]!;   // e.g. "- "
				const checkboxWithSp = match[3]!;   // e.g. "[x] "
				const checkbox       = checkboxWithSp.trim(); // "[x]"
				const indent         = match[1]!.length;
				const isLP           = view.state.field(editorLivePreviewField);

				if (isLP) {
					// Live preview: replace  "- [x]"  (bullet + checkbox, no trailing space)
					const decoFrom = from + indent;
					const decoTo   = from + indent + bulletWithSp.length + checkbox.length;
					add(
						decoFrom,
						decoTo,
						Decoration.replace({
							widget: new CheckboxIconWidget(
								plugin, view,
								decoFrom, decoTo,
								mark, bulletWithSp
							),
						})
					);
				} else {
					// Source mode: replace just "[x]"
					const decoFrom = from + indent + bulletWithSp.length;
					const decoTo   = decoFrom + checkbox.length;
					add(
						decoFrom,
						decoTo,
						Decoration.replace({
							widget: new CheckboxIconWidget(
								plugin, view,
								decoFrom, decoTo,
								mark, ""
							),
						})
					);
				}
			},
		});

		constructor(view: EditorView) {
			this.view = view;
			this.decorations = this.match.createDeco(view);
		}

		update(update: ViewUpdate): void {
			this.view = update.view;
			if (update.docChanged || update.viewportChanged || update.selectionSet) {
				this.decorations = this.match.updateDeco(update, this.decorations);
			}
		}

		destroy(): void {
			this.decorations = Decoration.none;
		}

		private shouldRender(view: EditorView, from: number, to: number): boolean {
			// Skip codeblocks and frontmatter
			const syntaxNode = syntaxTree(view.state).resolveInner(from + 1);
			const nodeProps = syntaxNode.type.prop(tokenClassNodeProp) as string | undefined;
			if (nodeProps) {
				const props = nodeProps.split(" ");
				if (props.includes("hmd-codeblock") || props.includes("hmd-frontmatter")) {
					return false;
				}
			}

			// Collapse decoration when cursor/selection is inside the range.
			// Exclusive right boundary: cursor AT `to` is NOT considered overlap,
			// which keeps the decoration visible after a click-cycle dispatch that
			// places the cursor at exactly `to` (the trailing space position).
			const overlap = view.state.selection.ranges.some(
				(r) => !(r.to <= from || r.from >= to)
			);
			if (overlap) return false;

			return true;
		}
	}

	const spec: PluginSpec<CheckboxIconsPlugin> = {
		// Re-filter decorations on every selection change so decorations near the
		// cursor collapse without requiring a full `updateDeco` rebuild.
		decorations: (v) => v.decorations.update({
			filter: (rangeFrom, rangeTo) => {
				for (const range of v.view.state.selection.ranges) {
					if (!(range.to <= rangeFrom || range.from >= rangeTo)) return false;
				}
				return true;
			},
		}),
	};

	// Keymap: Mod-l (Cmd+L) cycles our custom statuses on task lines, and falls
	// through to Obsidian's native "Toggle checkbox status" on plain list lines
	// so bullet → [ ] conversion still works.
	const TASK_LINE_RE = /^(\s*)((?:[-*+]|\d+[.)])\s)(\[(.)\])/;

	const cycleKeymap = Prec.highest(keymap.of([{
		key: "Mod-Enter",
		run(view: EditorView): boolean {
			if (!plugin.settings.enableCheckboxIcons) return false;

			const { state } = view;
			const changes: { from: number; to: number; insert: string }[] = [];

			for (const sel of state.selection.ranges) {
				const line = state.doc.lineAt(sel.head);
				const match = TASK_LINE_RE.exec(line.text);
				if (!match) return false; // non-task line — let Obsidian handle all

				const mark = match[4]!;
				const statuses = plugin.settings.checkboxStatuses ?? DEFAULT_CHECKBOX_STATUSES;
				const marks = statuses.map((s) => s.mark);
				const idx = marks.indexOf(mark);
				const next = marks[(idx + 1) % marks.length] ?? marks[0] ?? " ";

				const checkboxFrom = line.from + match[1]!.length + match[2]!.length;
				changes.push({ from: checkboxFrom, to: checkboxFrom + match[3]!.length, insert: `[${next}]` });
			}

			view.dispatch({ changes, annotations: checkboxCycleAnnotation.of("cycle") });
			return true;
		},
	}]));

	return [ViewPlugin.fromClass(CheckboxIconsPlugin, spec), cycleKeymap];
}
