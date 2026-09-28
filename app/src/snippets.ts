// Snippets: create / edit / delete / paste. Pure list operations over
// Model.snippets; update.ts wires them to Msgs (snippet_new/edit/delete/
// paste, draft_*). Paste writes the body to <dataDir>/tmp/paste.txt (Op
// write_paste) and then runs the helper's `paste` (contract.md "Paste flow").
//
// Validation (validateDraft): a name is required, the text must not be
// empty, a keyword has no spaces and is unique (case/accent-insensitive)
// among the OTHER snippets.

import { utf8Bytes } from "@native-sdk/core";
import type { Snippet } from "./shared.ts";
import type { SnippetDraft } from "./model.ts";
import { editWithText, emptyEdit } from "./model.ts";
import { bytesEqual, concat3, EMPTY, trimBytes } from "./bytes.ts";
import { foldText } from "./search.ts";

export const SNIPPET_NAME_CAPACITY = 256;
export const SNIPPET_KEYWORD_CAPACITY = 64;

export function newDraft(): SnippetDraft {
  return { id: 0, name: emptyEdit(), keyword: emptyEdit(), body: emptyEdit(), problem: EMPTY };
}

export function draftFor(snippets: readonly Snippet[], id: number): SnippetDraft | null {
  const s = snippets.find((x) => x.id === id);
  if (s === undefined) return null;
  return { id: s.id, name: editWithText(s.name), keyword: editWithText(s.keyword), body: editWithText(s.body), problem: EMPTY };
}

export function findSnippet(snippets: readonly Snippet[], id: number): Snippet | null {
  return snippets.find((x) => x.id === id) ?? null;
}

function hasSpace(text: Uint8Array): boolean {
  for (const b of text) {
    if (b === 32 || b === 9 || b === 10 || b === 13) return true;
  }
  return false;
}

/// Empty when the draft can be saved, otherwise the message to show.
export function validateDraft(snippets: readonly Snippet[], draft: SnippetDraft): Uint8Array {
  const name = trimBytes(draft.name.text);
  if (name.length === 0) return utf8Bytes("Give the snippet a name.");
  if (draft.body.text.length === 0) return utf8Bytes("The snippet text is empty.");
  const keyword = trimBytes(draft.keyword.text);
  if (keyword.length === 0) return EMPTY;
  if (hasSpace(keyword)) return utf8Bytes("A keyword cannot contain spaces.");
  const folded = foldText(keyword);
  const clash = snippets.find((s) => s.id !== draft.id && s.keyword.length > 0 && bytesEqual(foldText(s.keyword), folded));
  if (clash !== undefined) return concat3(utf8Bytes("That keyword is already used by “"), clash.name, utf8Bytes("”."));
  return EMPTY;
}

/// Insert (draft.id === 0, using newId) or replace the snippet. Call
/// validateDraft first.
export function saveDraft(snippets: readonly Snippet[], draft: SnippetDraft, newId: number, nowMs: number): readonly Snippet[] {
  const record: Snippet = {
    id: (draft.id === 0 ? newId : draft.id) | 0,
    name: trimBytes(draft.name.text),
    keyword: trimBytes(draft.keyword.text),
    body: draft.body.text,
    updatedMs: nowMs >= 0 && nowMs <= 4102444800000 ? Math.trunc(nowMs) : 0,
  };
  if (draft.id === 0 || !snippets.some((s) => s.id === draft.id)) return [...snippets, record];
  return snippets.map((s) => (s.id === draft.id ? record : s));
}

export function deleteSnippet(snippets: readonly Snippet[], id: number): readonly Snippet[] {
  return snippets.filter((s) => s.id !== id);
}
