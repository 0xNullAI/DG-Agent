/**
 * ui/sidebar.ts — History sidebar rendering.
 */

import type { ConversationRecord } from '../types';
import { history, conversation } from '../agent';
import { $ } from './index';

export function toggle(): void {
  const sidebar = $('sidebar')!;
  const isOpen = !sidebar.classList.contains('sidebar-closed');
  if (isOpen) close();
  else open();
}

export function open(): void {
  const sidebar = $('sidebar')!;
  sidebar.classList.remove('sidebar-closed');
  $('btn-sidebar')?.classList.add('active');

  if (window.innerWidth <= 1023) {
    $('sidebar-overlay')!.classList.remove('hidden');
  }
  renderList();
}

export function close(): void {
  $('sidebar')!.classList.add('sidebar-closed');
  $('btn-sidebar')?.classList.remove('active');
  $('sidebar-overlay')!.classList.add('hidden');
}

export function renderList(): void {
  const listEl = $('history-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const conversations = history.loadConversations();
  const current = conversation.getCurrentConversation();

  if (conversations.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '暂无历史记录';
    listEl.appendChild(empty);
    return;
  }

  conversations.forEach((conv) => {
    const item = document.createElement('div');
    item.className = 'history-item' + (current?.id === conv.id ? ' active' : '');

    const infoDiv = document.createElement('div');
    infoDiv.className = 'history-item-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'history-item-title';
    titleEl.textContent = conv.title;

    const dateEl = document.createElement('div');
    dateEl.className = 'history-item-date';
    dateEl.textContent = formatDate(conv.updatedAt);

    infoDiv.appendChild(titleEl);
    infoDiv.appendChild(dateEl);

    const delBtn = document.createElement('button');
    delBtn.className = 'history-item-del';
    delBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    delBtn.title = '删除';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      history.deleteConversation(conv.id);
      if (current?.id === conv.id) {
        conversation.startNewConversation();
        const messagesEl = $('messages');
        if (messagesEl) messagesEl.innerHTML = '';
      }
      renderList();
    });

    item.appendChild(infoDiv);
    item.appendChild(delBtn);
    item.addEventListener('click', () => {
      onLoadConversation(conv);
      if (window.innerWidth <= 1023) close();
    });

    listEl.appendChild(item);
  });
}

// Callback for loading a conversation — set by ui/index.ts
let onLoadConversation: (conv: ConversationRecord) => void = () => {};
export function setOnLoadConversation(fn: (conv: ConversationRecord) => void): void {
  onLoadConversation = fn;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
