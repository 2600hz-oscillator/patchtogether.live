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

import { EditorView, lineNumbers, highlightActiveLineGutter, keymap, drawSelection, highlightActiveLine } from '@codemirror/view';
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
