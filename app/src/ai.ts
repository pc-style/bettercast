// Quick AI. Owner: AI agent.
// Flow (contract.md "AI flow"): ai_ask -> write the request file
// <dataDir>/tmp/ai-request.txt (Op write_ai_request) -> ai_request_written
// -> (provider "api": Cmd.credentials.get -> ai_key_loaded) -> Op ai_start
// spawns `bettercast-helper ai --request <file>` with the API key (if any)
// on stdin -> `chunk <b64>` lines stream into Model.ai.answer -> `done`.

import { asciiBytes, utf8Bytes } from "@native-sdk/core";
import type { AiProviderChoice, ProviderInfo } from "./shared.ts";
import type { AiState, Attachment } from "./model.ts";
import { base64Encode, bytesEqual, concat2, concat3, joinBytes, EMPTY } from "./bytes.ts";

export function providerToken(p: AiProviderChoice): Uint8Array {
  switch (p) {
    case "claude": return asciiBytes("claude");
    case "codex": return asciiBytes("codex");
    case "gemini": return asciiBytes("gemini");
    case "opencode": return asciiBytes("opencode");
    case "api": return asciiBytes("api");
  }
}

export function binFor(providers: readonly ProviderInfo[], p: AiProviderChoice): Uint8Array {
  const found = providers.find((x) => x.id === p);
  return found === undefined ? EMPTY : found.binPath;
}

/// The request file the helper's `ai` subcommand reads:
///   provider <token>\n
///   bin <b64 path or ->\n
///   model <b64 name or ->\n
///   attach <b64 path>\n            (0..n lines)
///   prompt\n
///   <raw prompt bytes to EOF>
export function requestFile(provider: AiProviderChoice, bin: Uint8Array, modelName: Uint8Array, attachments: readonly Attachment[], prompt: Uint8Array): Uint8Array {
  const lines: Uint8Array[] = [];
  lines.push(concat2(asciiBytes("provider "), providerToken(provider)));
  lines.push(concat2(asciiBytes("bin "), bin.length > 0 ? base64Encode(bin) : asciiBytes("-")));
  lines.push(concat2(asciiBytes("model "), modelName.length > 0 ? base64Encode(modelName) : asciiBytes("-")));
  for (const a of attachments) lines.push(concat2(asciiBytes("attach "), base64Encode(a.path)));
  lines.push(asciiBytes("prompt"));
  lines.push(prompt);
  return joinBytes(lines, asciiBytes("\n"));
}

/// Largest answer kept in the Model (the rest of a runaway stream is
/// dropped; the helper also bounds each chunk).
export const MAX_ANSWER = 262144;
export const MAX_ATTACHMENTS = 8;
/// Earlier turns kept as follow-up context.
export const MAX_HISTORY = 32768;

export function appendAnswer(ai: AiState, text: Uint8Array): AiState {
  if (ai.answer.length >= MAX_ANSWER) return ai;
  const room = MAX_ANSWER - ai.answer.length;
  const piece = text.length > room ? text.subarray(0, room) : text;
  return { ...ai, answer: concat2(ai.answer, piece) };
}

export function providerTitle(p: AiProviderChoice): Uint8Array {
  switch (p) {
    case "claude": return utf8Bytes("Claude Code");
    case "codex": return utf8Bytes("Codex");
    case "gemini": return utf8Bytes("Gemini CLI");
    case "opencode": return utf8Bytes("OpenCode");
    case "api": return utf8Bytes("the API key provider");
  }
}

/// Empty when `p` can answer, otherwise what is missing and where to fix it.
export function providerProblem(providers: readonly ProviderInfo[], apiKeySet: boolean, p: AiProviderChoice): Uint8Array {
  if (p === "api") return apiKeySet ? EMPTY : utf8Bytes("No API key is stored. Save one in Manage > AI, or choose an installed CLI there.");
  if (binFor(providers, p).length > 0) return EMPTY;
  return concat3(providerTitle(p), utf8Bytes(" is not installed. "), utf8Bytes("Install it, or choose another provider in Manage > AI."));
}

/// The prompt the provider receives: earlier turns as context, then the
/// new question.
export function fullPrompt(history: Uint8Array, prompt: Uint8Array): Uint8Array {
  if (history.length === 0) return prompt;
  return joinBytes([
    utf8Bytes("Earlier in this conversation:"),
    history,
    utf8Bytes("Follow-up question:"),
    prompt,
  ], asciiBytes("\n\n"));
}

/// History after a finished (or stopped) turn, bounded to the most recent
/// MAX_HISTORY bytes.
export function historyAfter(ai: AiState): Uint8Array {
  if (ai.prompt.length === 0) return ai.history;
  const turn = joinBytes([concat2(utf8Bytes("Q: "), ai.prompt), concat2(utf8Bytes("A: "), ai.answer)], asciiBytes("\n\n"));
  const all = ai.history.length > 0 ? joinBytes([ai.history, turn], asciiBytes("\n\n")) : turn;
  if (all.length <= MAX_HISTORY) return all;
  let start = all.length - MAX_HISTORY;
  while (start < all.length && (all[start] & 192) === 128) start += 1;
  return all.subarray(start, all.length);
}

/// Add an attachment (deduplicated by path, at most MAX_ATTACHMENTS).
export function attach(ai: AiState, path: Uint8Array, isImage: boolean): AiState {
  if (path.length === 0 || ai.attachments.some((a) => bytesEqual(a.path, path))) return ai;
  if (ai.attachments.length >= MAX_ATTACHMENTS) return ai;
  return { ...ai, attachments: [...ai.attachments, { path: path, isImage: isImage }] };
}

export function detach(ai: AiState, index: number): AiState {
  return { ...ai, attachments: ai.attachments.filter((_a, i) => i !== index) };
}
