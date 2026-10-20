/**
 * AI Studio Chat Exporter - AI Studio content script
 * Exports AI Studio chat conversations to Markdown with LaTeX preservation
 * Version 4.0.0 - DOM-based extraction (no clipboard dependency)
 */

(function() {
  'use strict';

  const CONFIG = {
    BUTTON_ID: 'aistudio-export-btn',
    DROPDOWN_ID: 'aistudio-export-dropdown',
    FILENAME_INPUT_ID: 'aistudio-filename-input',
    SELECT_DROPDOWN_ID: 'aistudio-select-dropdown',
    CHECKBOX_CLASS: 'aistudio-export-checkbox',
    EXPORT_MODE_NAME: 'aistudio-export-mode',

    SELECTORS: {
      // Best guess for container, or we'll find the parent of turns
      CHAT_TURNS: 'ms-chat-turn',
      USER_CONTAINER: '.user-prompt-container[data-turn-role="User"]',
      MODEL_CONTAINER: '.model-prompt-container[data-turn-role="Model"]',
      THOUGHT_CHUNK: 'ms-thought-chunk',
      // AI Studio typically puts the actual markdown content in a wrapper or directly in the container
      // We'll target the container and let Turndown handle it, stripping thoughts first.
      TITLE: 'title' // Fallback to page title
    },

    TIMING: {
      SCROLL_DELAY: 200,
      SCROLL_STEP: 500,
      POPUP_DURATION: 900,
      NOTIFICATION_CLEANUP_DELAY: 1000,
      MAX_SCROLL_ATTEMPTS: 200,
      MAX_STABLE_SCROLLS: 5
    },

    STYLES: {
      BUTTON_PRIMARY: '#1a73e8',
      BUTTON_HOVER: '#1765c1',
      DARK_BG: '#111',
      DARK_TEXT: '#fff',
      DARK_BORDER: '#444',
      LIGHT_BG: '#fff',
      LIGHT_TEXT: '#222',
      LIGHT_BORDER: '#ccc'
    },

    DEFAULT_FILENAME: 'aistudio_chat_export',
    MARKDOWN_HEADER: '# AI Studio Chat Export',
    EXPORT_TIMESTAMP_FORMAT: 'Exported on:'
  };

  // ============================================================================
  // UTILITY SERVICES
  // ============================================================================

  class DateUtils {
    static getDateString() {
      const d = new Date();
      const pad = n => n.toString().padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }

    static getLocaleString() {
      return new Date().toLocaleString();
    }
  }

  class StringUtils {
    static sanitizeFilename(text) {
      return text
        .replace(/[\\/:*?"<>|.]/g, '')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '');
    }

    static removeCitations(text) {
      return text
        .replace(/\[cite_start\]/g, '')
        .replace(/\[cite:[\d,\s]+\]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  }

  class DOMUtils {
    static sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    static isDarkMode() {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    static createNotification(message) {
      const popup = document.createElement('div');
      Object.assign(popup.style, {
        position: 'fixed',
        top: '24px',
        right: '24px',
        zIndex: '99999',
        background: '#333',
        color: '#fff',
        padding: '10px 18px',
        borderRadius: '8px',
        fontSize: '1em',
        boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
        opacity: '0.95',
        pointerEvents: 'none'
      });
      popup.textContent = message;
      document.body.appendChild(popup);
      setTimeout(() => popup.remove(), CONFIG.TIMING.POPUP_DURATION);
      return popup;
    }
  }

  // ============================================================================
  // FILENAME SERVICE
  // ============================================================================

  class FilenameService {
    static getConversationTitle() {
      // AI Studio often uses the document title or a specific header
      // We'll try to find a header if possible, otherwise page title
      const pageTitle = document.title || '';
      return pageTitle.replace(' - Google AI Studio', '').trim();
    }

    static generate(customFilename, conversationTitle) {
      if (customFilename && customFilename.trim()) {
        const base = this._sanitizeCustomFilename(customFilename);
        return base || `${CONFIG.DEFAULT_FILENAME}_${DateUtils.getDateString()}`;
      }

      if (conversationTitle) {
        const safeTitle = StringUtils.sanitizeFilename(conversationTitle);
        if (safeTitle) return `${safeTitle}_${DateUtils.getDateString()}`;
      }

      return `${CONFIG.DEFAULT_FILENAME}_${DateUtils.getDateString()}`;
    }

    static _sanitizeCustomFilename(filename) {
      let base = filename.trim().replace(/\.[^/.]+$/, '');
      return base.replace(/[^a-zA-Z0-9_\-]/g, '_');
    }
  }

  // ============================================================================
  // SCROLL SERVICE
  // ============================================================================

  class ScrollService {
    static getScrollContainer() {
      // Try to find the scrollable parent of the chat turns
      const firstTurn = document.querySelector(CONFIG.SELECTORS.CHAT_TURNS);
      if (!firstTurn) return null;

      let parent = firstTurn.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          return parent;
        }
        parent = parent.parentElement;
      }
      return document.documentElement; // Fallback to window/body
    }

    static async loadAllMessages() {
      const scrollContainer = this.getScrollContainer();
      if (!scrollContainer) {
        // Just continue if we can't find it, user might have scrolled manually
        return;
      }

      let stableScrolls = 0;
      let scrollAttempts = 0;
      let lastScrollTop = -1;

      while (stableScrolls < CONFIG.TIMING.MAX_STABLE_SCROLLS &&
             scrollAttempts < CONFIG.TIMING.MAX_SCROLL_ATTEMPTS) {

        const currentScrollTop = scrollContainer.scrollTop;

        // Incremental scroll up
        if (currentScrollTop > 0) {
           scrollContainer.scrollTop = Math.max(0, currentScrollTop - CONFIG.TIMING.SCROLL_STEP);
        } else {
           scrollContainer.scrollTop = 0;
        }

        await DOMUtils.sleep(CONFIG.TIMING.SCROLL_DELAY);

        const newScrollTop = scrollContainer.scrollTop;

        if (newScrollTop === 0 && lastScrollTop === 0) {
           stableScrolls++;
        } else if (newScrollTop === 0 && lastScrollTop !== 0) {
           stableScrolls = 0;
        } else {
           stableScrolls = 0;
        }

        lastScrollTop = newScrollTop;
        scrollAttempts++;
      }
    }
  }

  // ============================================================================
  // FILE EXPORT SERVICE
  // ============================================================================

  class FileExportService {
    static downloadMarkdown(markdown, filenameBase) {
      this._download(markdown, filenameBase, 'md', 'text/markdown');
    }

    static downloadJSON(data, filenameBase) {
      const jsonStr = JSON.stringify(data, null, 2);
      this._download(jsonStr, filenameBase, 'json', 'application/json');
    }

    static _download(content, filenameBase, extension, mimeType) {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filenameBase}.${extension}`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, CONFIG.TIMING.NOTIFICATION_CLEANUP_DELAY);
    }

    static async exportToClipboard(markdown) {
      await navigator.clipboard.writeText(markdown);
      alert('Conversation copied to clipboard!');
    }
  }

  // ============================================================================
  // MARKDOWN CONVERTER SERVICE
  // ============================================================================

  class MarkdownConverter {
    constructor() {
      this.turndownService = this._createTurndownService();
    }

    _createTurndownService() {
      if (typeof window.TurndownService !== 'function') {
        return null;
      }

      const service = new window.TurndownService({
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**',
        headingStyle: 'atx',
        hr: '---',
        bulletListMarker: '-',
        codeBlockFence: '```'
      });

      // Add rules similar to Gemini if needed, but AI Studio HTML is cleaner usually.
      // We can add table support.
      service.addRule('table', {
        filter: 'table',
        replacement: (content, node) => {
            // Simplified table handling
            return '\n\n' + content + '\n\n';
        }
      });

      return service;
    }

    extractUserQuery(userContainer) {
      if (!userContainer) return '';
      // User query is usually just text in the container
      return userContainer.textContent.trim();
    }

    extractModelResponse(modelContainer) {
      if (!modelContainer) return { text: '', thought: '' };

      // Clone to avoid modifying DOM
      const clone = modelContainer.cloneNode(true);

      // Extract thought if present
      let thought = '';
      const thoughtChunk = clone.querySelector(CONFIG.SELECTORS.THOUGHT_CHUNK);
      if (thoughtChunk) {
        thought = thoughtChunk.textContent.trim();
        thoughtChunk.remove(); // Remove from clone so it doesn't appear in main text
      }

      let text = '';
      if (this.turndownService) {
        text = this.turndownService.turndown(clone.innerHTML);
      } else {
        text = clone.textContent.trim(); // Fallback
      }

      return { text: StringUtils.removeCitations(text), thought };
    }
  }

  // ============================================================================
  // CHECKBOX MANAGER
  // ============================================================================
  class CheckboxManager {
    createCheckbox(type, container) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = CONFIG.CHECKBOX_CLASS;
      cb.checked = true;
      cb.title = `Include this ${type} message in export`;

      Object.assign(cb.style, {
        position: 'absolute',
        right: '28px',
        top: '8px',
        zIndex: '10000',
        transform: 'scale(1.2)'
      });

      container.style.position = 'relative';
      container.appendChild(cb);
      return cb;
    }

    injectCheckboxes() {
      const turns = document.querySelectorAll(CONFIG.SELECTORS.CHAT_TURNS);

      turns.forEach(turn => {
        // User query checkbox
        const userContainer = turn.querySelector(CONFIG.SELECTORS.USER_CONTAINER);
        if (userContainer && !userContainer.querySelector(`.${CONFIG.CHECKBOX_CLASS}`)) {
          this.createCheckbox('user', userContainer);
        }

        // Model response checkbox
        const modelContainer = turn.querySelector(CONFIG.SELECTORS.MODEL_CONTAINER);
        if (modelContainer && !modelContainer.querySelector(`.${CONFIG.CHECKBOX_CLASS}`)) {
          this.createCheckbox('AI', modelContainer);
        }
      });
    }

    removeAll() {
      document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`).forEach(cb => cb.remove());
    }

    hasAnyChecked() {
      return Array.from(document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`))
        .some(cb => cb.checked);
    }
  }

  // ============================================================================
  // SELECTION MANAGER
  // ============================================================================
  class SelectionManager {
    constructor(checkboxManager) {
      this.checkboxManager = checkboxManager;
      this.lastSelection = 'all';
    }

    applySelection(value) {
      const checkboxes = document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`);

      switch(value) {
        case 'all':
          checkboxes.forEach(cb => cb.checked = true);
          break;
        case 'ai':
          document.querySelectorAll(`${CONFIG.SELECTORS.USER_CONTAINER} .${CONFIG.CHECKBOX_CLASS}`)
            .forEach(cb => cb.checked = false);
          document.querySelectorAll(`${CONFIG.SELECTORS.MODEL_CONTAINER} .${CONFIG.CHECKBOX_CLASS}`)
            .forEach(cb => cb.checked = true);
          break;
        case 'none':
          checkboxes.forEach(cb => cb.checked = false);
          break;
      }

      this.lastSelection = value;
    }

    reset() {
      this.lastSelection = 'all';
      const select = document.getElementById(CONFIG.SELECT_DROPDOWN_ID);
      if (select) select.value = 'all';
    }
  }

  // ============================================================================
  // UI BUILDER
  // ============================================================================
  class UIBuilder {
    static getInputStyles(isDark) {
      return isDark
        ? `background:${CONFIG.STYLES.DARK_BG};color:${CONFIG.STYLES.DARK_TEXT};border:1px solid ${CONFIG.STYLES.DARK_BORDER};`
        : `background:${CONFIG.STYLES.LIGHT_BG};color:${CONFIG.STYLES.LIGHT_TEXT};border:1px solid ${CONFIG.STYLES.LIGHT_BORDER};`;
    }

    static createDropdownHTML() {
      const isDark = DOMUtils.isDarkMode();
      const inputStyles = this.getInputStyles(isDark);

      return `
        <div style="margin-top:10px;">
          <label style="margin-right:10px;">
            <input type="radio" name="${CONFIG.EXPORT_MODE_NAME}" value="file" checked>
            Export as file
          </label>
          <label style="margin-right:10px;">
            <input type="radio" name="${CONFIG.EXPORT_MODE_NAME}" value="json">
            Export as JSON
          </label>
          <label>
            <input type="radio" name="${CONFIG.EXPORT_MODE_NAME}" value="clipboard">
            Export to clipboard
          </label>
        </div>
        <div id="aistudio-filename-row" style="margin-top:10px;display:block;">
          <label for="${CONFIG.FILENAME_INPUT_ID}" style="font-weight:bold;">
            Filename <span style='color:#888;font-weight:normal;'>(optional)</span>:
          </label>
          <input id="${CONFIG.FILENAME_INPUT_ID}" type="text"
                 style="margin-left:8px;padding:2px 8px;width:260px;${inputStyles}"
                 value="">
          <span style="display:block;font-size:0.95em;color:#888;margin-top:2px;">
            Optional. Leave blank to use chat title or timestamp.
            Do not include an extension.
          </span>
        </div>
        <div style="margin-top:14px;">
          <label style="font-weight:bold;">Select messages:</label>
          <select id="${CONFIG.SELECT_DROPDOWN_ID}"
                  style="margin-left:8px;padding:2px 8px;${inputStyles}">
            <option value="all">All</option>
            <option value="ai">Only answers</option>
            <option value="none">None</option>
            <option value="custom">Custom</option>
          </select>
        </div>
      `;
    }

    static createButton() {
      const btn = document.createElement('button');
      btn.id = CONFIG.BUTTON_ID;
      btn.textContent = 'Export Chat';

      Object.assign(btn.style, {
        position: 'fixed',
        top: '80px',
        right: '20px',
        zIndex: '9999',
        padding: '8px 16px',
        background: CONFIG.STYLES.BUTTON_PRIMARY,
        color: '#fff',
        border: 'none',
        borderRadius: '6px',
        fontSize: '1em',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        cursor: 'pointer',
        fontWeight: 'bold',
        transition: 'background 0.2s'
      });

      btn.addEventListener('mouseenter', () => btn.style.background = CONFIG.STYLES.BUTTON_HOVER);
      btn.addEventListener('mouseleave', () => btn.style.background = CONFIG.STYLES.BUTTON_PRIMARY);

      return btn;
    }

    static createDropdown() {
      const dropdown = document.createElement('div');
      dropdown.id = CONFIG.DROPDOWN_ID;

      const isDark = DOMUtils.isDarkMode();
      Object.assign(dropdown.style, {
        position: 'fixed',
        top: '124px',
        right: '20px',
        zIndex: '9999',
        border: '1px solid #ccc',
        borderRadius: '6px',
        padding: '10px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        display: 'none',
        background: isDark ? '#222' : '#fff',
        color: isDark ? '#fff' : '#222'
      });

      dropdown.innerHTML = this.createDropdownHTML();
      return dropdown;
    }
  }

  // ============================================================================
  // EXPORT SERVICE
  // ============================================================================
  class ExportService {
    constructor(checkboxManager) {
      this.checkboxManager = checkboxManager;
      this.markdownConverter = new MarkdownConverter();
    }

    _buildMarkdownHeader(conversationTitle) {
      const title = conversationTitle || CONFIG.MARKDOWN_HEADER;
      const timestamp = DateUtils.getLocaleString();
      return `# ${title}\n\n> ${CONFIG.EXPORT_TIMESTAMP_FORMAT} ${timestamp}\n\n---\n\n`;
    }

    async buildMarkdown(turns, conversationTitle) {
      let markdown = this._buildMarkdownHeader(conversationTitle);

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        DOMUtils.createNotification(`Processing message ${i + 1} of ${turns.length}...`);

        // User message
        const userContainer = turn.querySelector(CONFIG.SELECTORS.USER_CONTAINER);
        if (userContainer) {
          const cb = userContainer.querySelector(`.${CONFIG.CHECKBOX_CLASS}`);
          if (cb?.checked) {
            const userQuery = this.markdownConverter.extractUserQuery(userContainer);
            if (userQuery) {
              markdown += `## 👤 You\n\n${userQuery}\n\n`;
            }
          }
        }

        // Model response
        const modelContainer = turn.querySelector(CONFIG.SELECTORS.MODEL_CONTAINER);
        if (modelContainer) {
          const cb = modelContainer.querySelector(`.${CONFIG.CHECKBOX_CLASS}`);
          if (cb?.checked) {
            const { text, thought } = this.markdownConverter.extractModelResponse(modelContainer);

            if (thought) {
              markdown += `## 🧠 Thought\n\n> ${thought.replace(/\n/g, '\n> ')}\n\n`;
            }

            if (text) {
              markdown += `## 🤖 AI Studio\n\n${text}\n\n`;
            } else {
              markdown += `## 🤖 AI Studio\n\n[Note: Could not extract model response.]\n\n`;
            }
          }
        }

        markdown += '---\n\n';
      }

      return markdown;
    }

    async buildJSON(turns, conversationTitle) {
      const data = {
        title: conversationTitle || CONFIG.DEFAULT_FILENAME,
        exported_at: DateUtils.getLocaleString(),
        messages: []
      };

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        DOMUtils.createNotification(`Processing message ${i + 1} of ${turns.length}...`);

        // User message
        const userContainer = turn.querySelector(CONFIG.SELECTORS.USER_CONTAINER);
        if (userContainer) {
          const cb = userContainer.querySelector(`.${CONFIG.CHECKBOX_CLASS}`);
          if (cb?.checked) {
            const userQuery = this.markdownConverter.extractUserQuery(userContainer);
            if (userQuery) {
              data.messages.push({
                role: 'user',
                content: userQuery
              });
            }
          }
        }

        // Model response
        const modelContainer = turn.querySelector(CONFIG.SELECTORS.MODEL_CONTAINER);
        if (modelContainer) {
          const cb = modelContainer.querySelector(`.${CONFIG.CHECKBOX_CLASS}`);
          if (cb?.checked) {
            const { text, thought } = this.markdownConverter.extractModelResponse(modelContainer);
            data.messages.push({
              role: 'model',
              content: text || "[Note: Could not extract model response.]",
              thought: thought || null
            });
          }
        }
      }

      return data;
    }

    async execute(exportMode, customFilename) {
      try {
        await ScrollService.loadAllMessages();

        const turns = Array.from(document.querySelectorAll(CONFIG.SELECTORS.CHAT_TURNS));
        this.checkboxManager.injectCheckboxes();

        if (!this.checkboxManager.hasAnyChecked()) {
          alert('Please select at least one message to export using the checkboxes or the dropdown.');
          return;
        }

        const conversationTitle = FilenameService.getConversationTitle();

        if (exportMode === 'clipboard') {
          const markdown = await this.buildMarkdown(turns, conversationTitle);
          await FileExportService.exportToClipboard(markdown);
        } else if (exportMode === 'json') {
          const jsonData = await this.buildJSON(turns, conversationTitle);
          const filename = FilenameService.generate(customFilename, conversationTitle);
          FileExportService.downloadJSON(jsonData, filename);
        } else {
          const markdown = await this.buildMarkdown(turns, conversationTitle);
          const filename = FilenameService.generate(customFilename, conversationTitle);
          FileExportService.downloadMarkdown(markdown, filename);
        }

      } catch (error) {
        console.error('Export error:', error);
        alert(`Export failed: ${error.message}`);
      }
    }
  }

  // ============================================================================
  // EXPORT CONTROLLER
  // ============================================================================
  class ExportController {
    constructor() {
      this.checkboxManager = new CheckboxManager();
      this.selectionManager = new SelectionManager(this.checkboxManager);
      this.exportService = new ExportService(this.checkboxManager);
      this.button = null;
      this.dropdown = null;
    }

    init() {
      this.createUI();
      this.attachEventListeners();
      this.observeStorageChanges();
    }

    createUI() {
      this.button = UIBuilder.createButton();
      this.dropdown = UIBuilder.createDropdown();

      document.body.appendChild(this.dropdown);
      document.body.appendChild(this.button);

      this.setupFilenameRowToggle();
    }

    setupFilenameRowToggle() {
      const updateFilenameRow = () => {
        const fileRow = this.dropdown.querySelector('#aistudio-filename-row');
        const fileRadio = this.dropdown.querySelector(`input[name="${CONFIG.EXPORT_MODE_NAME}"][value="file"]`);
        const jsonRadio = this.dropdown.querySelector(`input[name="${CONFIG.EXPORT_MODE_NAME}"][value="json"]`);

        let shouldShow = false;
        if (fileRadio && fileRadio.checked) shouldShow = true;
        if (jsonRadio && jsonRadio.checked) shouldShow = true;

        if (fileRow) {
          fileRow.style.display = shouldShow ? 'block' : 'none';
        }
      };

      this.dropdown.querySelectorAll(`input[name="${CONFIG.EXPORT_MODE_NAME}"]`)
        .forEach(radio => radio.addEventListener('change', updateFilenameRow));

      updateFilenameRow();
    }

    attachEventListeners() {
      this.button.addEventListener('click', () => this.handleButtonClick());

      const selectDropdown = this.dropdown.querySelector(`#${CONFIG.SELECT_DROPDOWN_ID}`);
      selectDropdown.addEventListener('change', (e) => this.handleSelectionChange(e.target.value));

      document.addEventListener('change', (e) => {
        if (e.target?.classList?.contains(CONFIG.CHECKBOX_CLASS)) {
          const select = document.getElementById(CONFIG.SELECT_DROPDOWN_ID);
          if (select && select.value !== 'custom') {
            select.value = 'custom';
            this.selectionManager.lastSelection = 'custom'; // This line might need a fix in manager? No, manager has lastSelection property.
          }
        }
      });

      document.addEventListener('mousedown', (e) => {
        if (this.dropdown.style.display !== 'none' &&
            !this.dropdown.contains(e.target) &&
            e.target !== this.button) {
          this.dropdown.style.display = 'none';
        }
      });
    }

    handleSelectionChange(value) {
      this.checkboxManager.injectCheckboxes();
      this.selectionManager.applySelection(value);
    }

    async handleButtonClick() {
      this.checkboxManager.injectCheckboxes();

      if (this.dropdown.style.display === 'none') {
        this.dropdown.style.display = '';
        return;
      }

      this.button.disabled = true;
      this.button.textContent = 'Exporting...';

      try {
        const exportMode = this.dropdown.querySelector(`input[name="${CONFIG.EXPORT_MODE_NAME}"]:checked`)?.value || 'file';
        const customFilename = (exportMode === 'file' || exportMode === 'json')
          ? this.dropdown.querySelector(`#${CONFIG.FILENAME_INPUT_ID}`)?.value.trim() || ''
          : '';

        this.dropdown.style.display = 'none';

        await this.exportService.execute(exportMode, customFilename);

        this.checkboxManager.removeAll();
        this.selectionManager.reset();

        if (exportMode === 'file' || exportMode === 'json') {
          const filenameInput = this.dropdown.querySelector(`#${CONFIG.FILENAME_INPUT_ID}`);
          if (filenameInput) filenameInput.value = '';
        }

      } catch (error) {
        console.error('Export error:', error);
      } finally {
        this.button.disabled = false;
        this.button.textContent = 'Export Chat';
      }
    }

    observeStorageChanges() {
      const updateVisibility = () => {
        try {
          if (chrome?.storage?.sync) {
            chrome.storage.sync.get(['hideExportBtn'], (result) => {
              this.button.style.display = result.hideExportBtn ? 'none' : '';
            });
          }
        } catch (e) {
          console.error('Storage access error:', e);
        }
      };

      updateVisibility();

      const observer = new MutationObserver(updateVisibility);
      observer.observe(document.body, { childList: true, subtree: true });

      if (chrome?.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'sync' && 'hideExportBtn' in changes) {
            updateVisibility();
          }
        });
      }
    }
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================
  const controller = new ExportController();
  controller.init();

})();
