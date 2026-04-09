/**
 * history.ts -- Chat history persistence using localStorage
 */

import type { ConversationRecord } from '../types';

const STORAGE_KEY = 'dg-agent-history';
const MAX_CONVERSATIONS = 50;

/** Load all saved conversations, sorted by updatedAt desc */
export function loadConversations(): ConversationRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list: ConversationRecord[] = JSON.parse(raw);
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  } catch {
    return [];
  }
}

/** Save a conversation (insert or update) */
export function saveConversation(conv: ConversationRecord): void {
  const list = loadConversations();
  const idx = list.findIndex((c) => c.id === conv.id);
  if (idx >= 0) {
    list[idx] = conv;
  } else {
    list.push(conv);
  }
  // Sort by updatedAt desc
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  // Trim to MAX_CONVERSATIONS (remove oldest)
  const trimmed = list.slice(0, MAX_CONVERSATIONS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota exceeded */
  }
}

/** Delete a conversation by id */
export function deleteConversation(id: string): void {
  const list = loadConversations().filter((c) => c.id !== id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* quota exceeded */
  }
}

/** Create a new empty conversation record */
export function createConversation(presetId: string): ConversationRecord {
  const now = Date.now();
  const id = now.toString(36) + Math.random().toString(36).slice(2, 6);
  return {
    id,
    title: '\u65B0\u5BF9\u8BDD',
    messages: [],
    presetId,
    createdAt: now,
    updatedAt: now,
  };
}

/** Generate a title from the first user message (truncate to 30 chars) */
export function generateTitle(messages: { role: string; content: string }[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser || typeof firstUser.content !== 'string') return '\u65B0\u5BF9\u8BDD';
  const text = firstUser.content.trim();
  if (text.length <= 30) return text;
  return text.slice(0, 30) + '...';
}
