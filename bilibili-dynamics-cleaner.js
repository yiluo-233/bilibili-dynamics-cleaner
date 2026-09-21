// ==UserScript==
// @name         B站抽奖转发清理器
// @namespace    https://github.com/yiluo-233/bilibili-dynamics-cleaner/
// @version      1.5.0
// @description  扫描全部历史动态，仅列出带“互动抽奖”节点的转发及源动态已删除的转发，确认后批量删除。
// @author       Yiluo, Codex
// @match        https://space.bilibili.com/*/dynamic*
// @icon         https://www.bilibili.com/favicon.ico
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const API_BASE = 'https://api.bilibili.com';
  const PAGE_DELAY_MS = 450;
  const DELETE_DELAY_MIN_MS = 1800;
  const DELETE_DELAY_MAX_MS = 3000;

  const state = {
    scanning: false,
    deleting: false,
    candidates: [],
    scanned: 0,
    pages: 0,
    displayedCandidateCount: 0,
    deleteTotal: 0,
    deletedCount: 0,
    deleteFailed: false,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randomDelay = () => DELETE_DELAY_MIN_MS
    + Math.floor(Math.random() * (DELETE_DELAY_MAX_MS - DELETE_DELAY_MIN_MS + 1));

  function cookie(name) {
    const prefix = `${name}=`;
    const part = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(prefix));
    return part ? decodeURIComponent(part.slice(prefix.length)) : '';
  }

  function getSpaceUid() {
    const match = location.pathname.match(/^\/(\d+)\/dynamic(?:\/|$)/);
    return match ? match[1] : '';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function truncate(value, length = 100) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > length ? `${text.slice(0, length)}…` : text;
  }

  function isForward(item) {
    return item?.type === 'DYNAMIC_TYPE_FORWARD';
  }

  function isDeletedSource(item) {
    const orig = item?.orig;
    if (!orig) return true;
    if (orig.type === 'DYNAMIC_TYPE_NONE') return true;
    if (orig.visible === false) return true;
    const tips = orig?.modules?.module_dynamic?.major?.none?.tips;
    return typeof tips === 'string' && /删除|失效|不存在|不可见/.test(tips);
  }

  // 只在源动态对象内寻找 B 站的专用互动抽奖富文本节点，不以普通文字关键词判定。
  function containsLotteryNode(root) {
    const seen = new WeakSet();
    function visit(value) {
      if (!value || typeof value !== 'object') return false;
      if (seen.has(value)) return false;
      seen.add(value);
      if (value.type === 'RICH_TEXT_NODE_TYPE_LOTTERY') return true;
      if (Array.isArray(value)) return value.some(visit);
      return Object.values(value).some(visit);
    }
    return visit(root);
  }

  function dynamicText(dynamic) {
    const moduleDynamic = dynamic?.modules?.module_dynamic;
    return moduleDynamic?.desc?.text
      || moduleDynamic?.major?.opus?.summary?.text
      || moduleDynamic?.major?.archive?.title
      || '';
  }

  function toCandidate(item) {
    if (!isForward(item)) return null;
    const deletedSource = isDeletedSource(item);
    const lottery = !deletedSource && containsLotteryNode(item.orig);
    if (!deletedSource && !lottery) return null;

    const author = item?.orig?.modules?.module_author;
    const pubTs = Number(item?.modules?.module_author?.pub_ts || 0);
    return {
      id: String(item.id_str),
      reason: deletedSource ? '源动态已删除/不可见' : '互动抽奖转发',
      sourceAuthor: author?.name || '未知来源',
      date: pubTs ? new Date(pubTs * 1000).toLocaleString() : '时间未知',
      text: truncate(dynamicText(item) || dynamicText(item.orig) || '（无文字）'),
      selected: true,
      status: '待删除',
    };
  }

  async function apiJson(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', ...options });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (result.code !== 0) throw new Error(`${result.message || '接口请求失败'}（code ${result.code}）`);
    return result;
  }

  async function scanAll() {
    if (state.scanning || state.deleting) return;
    const loggedInUid = cookie('DedeUserID');
    const spaceUid = getSpaceUid();
    if (!loggedInUid) throw new Error('未检测到登录状态，请先登录 B 站。');
    if (!spaceUid) throw new Error('无法从当前网址识别空间 UID。');
    if (loggedInUid !== spaceUid) {
      throw new Error(`当前登录 UID 为 ${loggedInUid}，但页面属于 UID ${spaceUid}。脚本只允许清理自己的空间。`);
    }

    state.scanning = true;
    state.candidates = [];
    state.scanned = 0;
    state.pages = 0;
    state.displayedCandidateCount = 0;
    state.deleteTotal = 0;
    state.deletedCount = 0;
    state.deleteFailed = false;
    render();

    const seenIds = new Set();
    let offset = '';
    try {
      while (true) {
        const query = new URLSearchParams({
          host_mid: spaceUid,
          timezone_offset: String(new Date().getTimezoneOffset()),
          features: 'itemOpusStyle',
        });
        if (offset) query.set('offset', offset);
        const result = await apiJson(`${API_BASE}/x/polymer/web-dynamic/v1/feed/space?${query}`);
        const data = result.data || {};
        const items = Array.isArray(data.items) ? data.items : [];
        state.pages += 1;

        for (const item of items) {
          const id = String(item?.id_str || '');
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          state.scanned += 1;
          const candidate = toCandidate(item);
          if (candidate) {
            state.candidates.push(candidate);
            if (state.candidates.length % 5 === 0) {
              state.displayedCandidateCount = state.candidates.length;
              render();
              // 让浏览器有机会绘制 5、10、15……这些阶段性进度。
              await sleep(0);
            }
          }
        }

        const nextOffset = String(data.offset || '');
        if (!data.has_more || !nextOffset || nextOffset === offset || items.length === 0) break;
        offset = nextOffset;
        await sleep(PAGE_DELAY_MS);
      }
      state.displayedCandidateCount = state.candidates.length;
      render();
    } finally {
      state.scanning = false;
      render();
    }
  }

  async function removeDynamic(id) {
    const csrf = cookie('bili_jct');
    if (!csrf) throw new Error('无法读取 bili_jct，请重新登录 B 站后再试。');
    return apiJson(`${API_BASE}/x/dynamic/feed/operate/remove?platform=web&csrf=${encodeURIComponent(csrf)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dyn_id_str: id }),
    });
  }

  async function deleteSelected() {
    if (state.scanning || state.deleting) return;
    const selected = state.candidates.filter((item) => item.selected && item.status !== '已删除');
    if (!selected.length) {
      window.alert('没有选中待删除的动态。');
      return;
    }

    state.deleting = true;
    state.deleteTotal = selected.length;
    state.deletedCount = 0;
    state.deleteFailed = false;
    render();
    for (let i = 0; i < selected.length; i += 1) {
      const item = selected[i];
      item.status = `删除中（${i + 1}/${selected.length}）`;
      render();
      try {
        await removeDynamic(item.id);
        item.status = '已删除';
        state.deletedCount += 1;
        render();
      } catch (error) {
        item.status = `失败：${error.message}`;
        state.deleting = false;
        state.deleteFailed = true;
        render();
        window.alert(`删除动态 ${item.id} 失败，已停止后续操作：\n${error.message}`);
        return;
      }
      render();
      if (i < selected.length - 1) await sleep(randomDelay());
    }
    state.deleting = false;
    render();
  }

  function selectedCount() {
    return state.candidates.filter((item) => item.selected && item.status !== '已删除').length;
  }

  function render() {
    const panel = document.getElementById('blrc-panel');
    if (!panel) return;
    const launcher = document.getElementById('blrc-launcher');
    const scanButton = panel.querySelector('[data-action="scan"]');
    const deleteButton = panel.querySelector('[data-action="delete"]');
    const closeButton = panel.querySelector('[data-action="close"]');
    const summary = panel.querySelector('.blrc-summary');
    const list = panel.querySelector('.blrc-list');

    const visibleCandidates = state.scanning
      ? state.candidates.slice(0, state.displayedCandidateCount)
      : state.candidates;
    const visibleSelectedCount = visibleCandidates.filter((item) => item.selected && item.status !== '已删除').length;

    scanButton.disabled = state.scanning || state.deleting;
    scanButton.textContent = state.scanning ? `扫描中：${state.pages} 页 / ${state.scanned} 条` : '扫描全部历史动态';
    deleteButton.disabled = state.scanning || state.deleting || visibleSelectedCount === 0;
    if (state.deleting) {
      deleteButton.textContent = `删除选中项（${state.deletedCount} / ${state.deleteTotal}）`;
    } else if (state.deleteFailed) {
      deleteButton.textContent = `删除失败（${state.deletedCount} / ${state.deleteTotal}）`;
    } else if (state.deleteTotal > 0 && state.deletedCount === state.deleteTotal) {
      deleteButton.textContent = `删除选中项（${state.deletedCount} / ${state.deleteTotal}）`;
    } else {
      deleteButton.textContent = `删除选中项（${visibleSelectedCount}）`;
    }
    closeButton.textContent = state.scanning || state.deleting ? '最小化' : '关闭';
    launcher.textContent = state.scanning ? `扫描中 ${state.displayedCandidateCount}` : '清理抽奖转发';
    launcher.classList.toggle('is-active', state.scanning || state.deleting);
    summary.textContent = state.scanning
      ? `正在扫描，已发现 ${state.candidates.length} 条候选动态。`
      : `已扫描 ${state.scanned} 条动态，发现 ${state.candidates.length} 条候选动态。`;
    if (!visibleCandidates.length) {
      list.innerHTML = '<div class="blrc-empty">扫描结果会显示在这里；脚本不会自动删除。</div>';
      return;
    }
    list.innerHTML = visibleCandidates.map((item, index) => `
      <label class="blrc-item ${item.status === '已删除' ? 'is-deleted' : ''}">
        <input type="checkbox" data-index="${index}" ${item.selected ? 'checked' : ''}
          ${state.deleting || item.status === '已删除' ? 'disabled' : ''}>
        <span class="blrc-content">
          <span class="blrc-line"><b>${escapeHtml(item.reason)}</b> · ${escapeHtml(item.sourceAuthor)} · ${escapeHtml(item.date)}</span>
          <span class="blrc-text">${escapeHtml(item.text)}</span>
          <span class="blrc-meta">ID ${escapeHtml(item.id)} · ${escapeHtml(item.status)} · <a href="https://www.bilibili.com/opus/${encodeURIComponent(item.id)}" target="_blank" rel="noopener">打开</a></span>
        </span>
      </label>`).join('');
  }

  function mount() {
    if (document.getElementById('blrc-launcher')) return;
    const style = document.createElement('style');
    style.textContent = `
      #blrc-launcher{position:fixed;left:24px;bottom:72px;z-index:2147483646;border:0;border-radius:6px;padding:8px 13px;background:#00aeec;color:#fff;font-size:12px;font-weight:700;box-shadow:0 3px 12px #0003;cursor:pointer}
      #blrc-launcher.is-active::after{content:"";position:absolute;right:-3px;top:-3px;width:5px;height:5px;border-radius:50%;background:#f5222d;box-shadow:0 1px 4px #0004}
      #blrc-panel{display:none;position:fixed;inset:6vh 6vw;z-index:2147483647;background:#fff;color:#18191c;border-radius:12px;box-shadow:0 12px 48px #0006;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
      #blrc-panel.is-open{display:flex;flex-direction:column}.blrc-head{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid #e3e5e7}.blrc-title{font-size:18px;font-weight:700;margin-right:auto}.blrc-head button{border:1px solid #c9ccd0;border-radius:6px;padding:8px 13px;background:#fff;cursor:pointer}.blrc-head button:disabled{opacity:.5;cursor:not-allowed}.blrc-head [data-action=delete]{background:#fa5a57;border-color:#fa5a57;color:#fff}.blrc-summary{padding:10px 20px;background:#f6f7f8;color:#61666d}.blrc-note{padding:0 20px 10px;background:#f6f7f8;color:#9499a0;font-size:12px}.blrc-list{overflow:auto;padding:8px 20px 20px}.blrc-item{display:flex;gap:12px;padding:12px 4px;border-bottom:1px solid #e3e5e7}.blrc-item.is-deleted{opacity:.5}.blrc-content{min-width:0;display:flex;flex-direction:column;gap:3px}.blrc-line{color:#18191c}.blrc-text{color:#61666d}.blrc-meta{font-size:12px;color:#9499a0}.blrc-meta a{color:#00aeec}.blrc-empty{padding:50px;text-align:center;color:#9499a0}
    `;
    document.head.appendChild(style);

    const launcher = document.createElement('button');
    launcher.id = 'blrc-launcher';
    launcher.textContent = '清理抽奖转发';
    document.body.appendChild(launcher);

    const panel = document.createElement('section');
    panel.id = 'blrc-panel';
    panel.innerHTML = `
      <div class="blrc-head">
        <span class="blrc-title">B站抽奖转发清理器</span>
        <button data-action="scan">扫描全部历史动态</button>
        <button data-action="delete" disabled>删除选中项（0）</button>
        <button data-action="close">关闭</button>
      </div>
      <div class="blrc-summary">尚未扫描。</div>
      <div class="blrc-note">仅匹配：①源动态含官方“互动抽奖”节点的转发；②源动态已删除或不可见的转发。原创动态不会进入清单。</div>
      <div class="blrc-list"><div class="blrc-empty">点击“扫描全部历史动态”开始；脚本不会自动删除。</div></div>`;
    document.body.appendChild(panel);

    launcher.addEventListener('click', () => panel.classList.add('is-open'));
    panel.querySelector('[data-action="close"]').addEventListener('click', () => {
      panel.classList.remove('is-open');
    });
    panel.querySelector('[data-action="scan"]').addEventListener('click', () => {
      scanAll().catch((error) => {
        state.scanning = false;
        state.displayedCandidateCount = state.candidates.length;
        render();
        window.alert(`扫描失败：${error.message}`);
      });
    });
    panel.querySelector('[data-action="delete"]').addEventListener('click', deleteSelected);
    panel.querySelector('.blrc-list').addEventListener('change', (event) => {
      const input = event.target.closest('input[type="checkbox"][data-index]');
      if (!input) return;
      const item = state.candidates[Number(input.dataset.index)];
      if (item) item.selected = input.checked;
      render();
    });
    render();
  }

  mount();
})();
