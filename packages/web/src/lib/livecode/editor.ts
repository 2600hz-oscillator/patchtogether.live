// packages/web/src/lib/livecode/editor.ts
//
// CodeMirror 6 EditorView factory. Shared between LivecodeCard (full
// editor with autocomplete + linting) and ClockedRunnerCard (compact
// editor for the body of a single clocked() callback).
//
// Why a factory: CodeMirror requires the view + state to be mounted
// against a real DOM element, and the lifecycle (replace doc, swap
// extensions for context changes) is the same shape in both cards.
// Centralizing here keeps both cards minimal.

import { EditorView, lineNumbers, highlightActiveLineGutter, keymap, drawSelection, highlightActiveLine, tooltips } from '@codemirror/view';
import { EditorState, type Extension, type Compartment as CompartmentT } from '@codemirror/state';
import { Compartment } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion, completionKeymap, type CompletionSource } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { linter, lintGutter, type LintSource } from '@codemirror/lint';

export interface MakeEditorInput {
  /** DOM element to mount the editor into (typically a <div> in the card). */
  parent: HTMLElement;
  /** Initial document value. */
  doc: string;
  /** Called on every doc change (debounced by CodeMirror's own keystroke
   *  cadence; consumer can debounce further). */
  onChange: (value: string) => void;
  /** Optional autocomplete source (port-aware completions). */
  completionSource?: CompletionSource;
  /** Optional linter (port-validity diagnostics). */
  lintSource?: LintSource;
  /** When true (default), show line numbers + gutter. Compact mode for
   *  the clocked-runner card sets this false. */
  showGutter?: boolean;
}

export interface EditorHandle {
  view: EditorView;
  /** Replace the doc value from outside (e.g. yjs remote update).
   *  No-op if the new value matches the current doc. */
  setDoc: (value: string) => void;
  /** Tear down the editor (call from onDestroy). */
  destroy: () => void;
}

export function makeEditor(input: MakeEditorInput): EditorHandle {
  const completionCompartment: CompartmentT = new Compartment();
  const lintCompartment: CompartmentT = new Compartment();

  const baseExtensions: Extension[] = [
    history(),
    // ROOT-CAUSE FIX for "no code completion at all": the LIVECODE /
    // CLOCKED cards wrap the editor in `overflow: hidden` chrome (and live
    // inside SvelteFlow's transformed viewport). CodeMirror's autocomplete
    // dropdown defaults to `position: absolute` rendered INSIDE `.cm-editor`,
    // and it flips/positions against the WINDOW viewport — so the moment the
    // caret is a few lines down, the downward-opening dropdown extends past
    // the editor's clip box and the card's `overflow: hidden` clips it to
    // nothing. (On line 1 it happens to fit, which is why it "sometimes
    // worked".) Re-parenting tooltips to <body> escapes the clip boxes
    // entirely; the dropdown is positioned in screen space (correct under the
    // viewport transform) and renders at 100% scale so it stays readable at
    // any zoom. Also fixes the lint hover tooltips. Guard for SSR — makeEditor
    // only runs client-side, but keep it defensive.
    ...(typeof document !== 'undefined' ? [tooltips({ parent: document.body })] : []),
    drawSelection(),
    bracketMatching(),
    indentOnInput(),
    javascript(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((upd) => {
      if (upd.docChanged) input.onChange(upd.state.doc.toString());
    }),
    EditorView.theme(
      {
        '&': {
          height: '100%',
          backgroundColor: 'rgba(10, 12, 16, 0.7)',
          color: 'var(--text)',
          fontSize: '0.78rem',
        },
        '.cm-scroller': {
          fontFamily: 'ui-monospace, JetBrains Mono, monospace',
          lineHeight: '1.5',
        },
        '.cm-gutters': {
          backgroundColor: 'rgba(10, 12, 16, 0.5)',
          color: 'var(--text-dim)',
          borderRight: '1px solid rgba(255, 255, 255, 0.05)',
        },
        '.cm-activeLineGutter': { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
        '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.02)' },
        '&.cm-focused': { outline: 'none' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          backgroundColor: 'rgba(120, 200, 255, 0.18)',
        },
        '.cm-diagnostic-error': {
          borderLeft: '3px solid #fca5a5',
        },
        // Autocomplete dropdown — reparented to <body> (see tooltips()
        // above), so it must out-rank SvelteFlow's stacking contexts and
        // stay legible on the dark card chrome.
        '.cm-tooltip': {
          zIndex: '9999',
        },
        '.cm-tooltip.cm-tooltip-autocomplete': {
          border: '1px solid rgba(120, 200, 255, 0.35)',
          borderRadius: '4px',
          background: 'rgba(16, 19, 26, 0.98)',
          boxShadow: '0 6px 24px rgba(0, 0, 0, 0.5)',
          fontFamily: 'ui-monospace, JetBrains Mono, monospace',
          fontSize: '0.74rem',
        },
        '.cm-tooltip-autocomplete > ul > li': {
          padding: '2px 8px',
          lineHeight: '1.5',
        },
        '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
          backgroundColor: 'rgba(120, 200, 255, 0.22)',
          color: 'var(--text, #e6edf3)',
        },
        '.cm-completionDetail': {
          fontStyle: 'italic',
          opacity: '0.7',
          marginLeft: '0.6em',
        },
        '.cm-tooltip.cm-completionInfo': {
          border: '1px solid rgba(120, 200, 255, 0.25)',
          background: 'rgba(16, 19, 26, 0.98)',
          padding: '6px 8px',
          maxWidth: '320px',
        },
      },
      { dark: true },
    ),
  ];

  if (input.showGutter !== false) {
    baseExtensions.push(lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), lintGutter());
  }

  const state = EditorState.create({
    doc: input.doc,
    extensions: [
      ...baseExtensions,
      completionCompartment.of(
        input.completionSource
          ? autocompletion({ override: [input.completionSource], activateOnTyping: true })
          : autocompletion({ activateOnTyping: true }),
      ),
      lintCompartment.of(input.lintSource ? linter(input.lintSource) : []),
    ],
  });

  const view = new EditorView({ state, parent: input.parent });

  return {
    view,
    setDoc(value: string) {
      const current = view.state.doc.toString();
      if (current === value) return;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    },
    destroy() {
      view.destroy();
    },
  };
}
