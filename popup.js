/**
 * popup.js
 * Handles the extension popup UI for hiding/showing the export button and update notifications.
 *
 * Features:
 * - Checkbox to hide/show export button on supported chat pages.
 * - Persists user choice using chrome.storage.sync.
 * - Checks chrome.storage.local for update availability flag set by background script.
 */

// Get UI elements
const hideExportBtnCheckbox = document.getElementById('hideExportBtn');
const updateNotification = document.getElementById('update-notification');
const updateLink = document.getElementById('update-link');

// Load saved state from chrome.storage and update checkbox
chrome.storage.sync.get(['hideExportBtn'], (result) => {
  hideExportBtnCheckbox.checked = !!result.hideExportBtn;
});

// Save state when checkbox is toggled
hideExportBtnCheckbox.addEventListener('change', (e) => {
  chrome.storage.sync.set({ hideExportBtn: hideExportBtnCheckbox.checked });
});

// Check for updates (flag set by background.js)
chrome.storage.local.get(['updateAvailable', 'newVersion'], (result) => {
  if (result.updateAvailable) {
    updateNotification.style.display = 'block';
    if (result.newVersion) {
      updateLink.textContent = `Update Available (v${result.newVersion})`;
    }
    // Update this URL to match your repository
    updateLink.href = 'https://github.com/INSERT_GITHUB_USERNAME/ai-chat-exporter/releases';
  }
});
