import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import styled, { useTheme } from "styled-components";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Lets CodeMirror dismiss its search/completion before Escape closes the dialog.
 *
 * @param event the dialog's capture-phase Escape event.
 */
export function handleTablePythonEscape(event: KeyboardEvent): void {
  if (event.isComposing) {
    event.preventDefault();
    return;
  }
  if (!(event.target instanceof HTMLElement)) {
    return;
  }
  const container = event.target.closest(".cm-editor");
  if (!(container instanceof HTMLElement)) {
    return;
  }
  const editor = EditorView.findFromDOM(container);
  if (
    editor &&
    runScopeHandlers(
      editor,
      event,
      event.target.closest(".cm-search") ? "search-panel" : "editor"
    )
  ) {
    event.preventDefault();
  }
}

/**
 * Embeds a Python CodeMirror editor with native selection, history and completion.
 *
 * @param props the controlled source and local change handler.
 * @returns the theme-aware source editor.
 */
export function TablePythonEditor({ value, onChange }: Props) {
  const theme = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const change = useRef(onChange);
  change.current = onChange;
  const appearance = useRef(new Compartment());
  const initial = useRef(value);

  useEffect(() => {
    if (!container.current) {
      return;
    }
    const editor = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          basicSetup,
          python(),
          appearance.current.of([]),
          EditorView.contentAttributes.of({
            "aria-label": "Python source",
            spellcheck: "false",
            "data-private": "true",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              change.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = undefined;
      editor.destroy();
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: appearance.current.reconfigure([
        syntaxHighlighting(
          HighlightStyle.define([
            { tag: tags.comment, color: theme.codeComment },
            {
              tag: [tags.keyword, tags.bool, tags.null],
              color: theme.codeKeyword,
            },
            { tag: tags.string, color: theme.codeString },
            { tag: tags.number, color: theme.codeNumber },
            { tag: tags.operator, color: theme.codeOperator },
            {
              tag: [tags.variableName, tags.propertyName, tags.punctuation],
              color: theme.text,
            },
          ])
        ),
        EditorView.theme(
          {
            "&": {
              height: "100%",
              color: theme.text,
              backgroundColor: theme.background,
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
              fontSize: "13px",
            },
            ".cm-gutters": {
              color: theme.textTertiary,
              backgroundColor: theme.backgroundSecondary,
              borderColor: theme.divider,
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: theme.backgroundSecondary,
            },
            ".cm-cursor": { borderLeftColor: theme.text },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
              backgroundColor: theme.tableSelectedBackground,
            },
            ".cm-panels": {
              color: theme.text,
              backgroundColor: theme.backgroundSecondary,
            },
            ".cm-tooltip": {
              color: theme.text,
              backgroundColor: theme.backgroundSecondary,
              borderColor: theme.divider,
            },
            "&.cm-focused": { outline: "none" },
          },
          { dark: theme.isDark }
        ),
      ]),
    });
  }, [theme]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
      });
    }
  }, [value]);

  return <Container ref={container} data-table-python-editor />;
}

const Container = styled.div`
  flex: 1;
  min-height: 100px;
  min-width: 0;
  overflow: hidden;
`;
