const GITHUB_MANIFEST_URL = 'https://raw.githubusercontent.com/INSERT_GITHUB_USERNAME/ai-chat-exporter/main/manifest.json';

function compareVersions(v1, v2) {
  const v1Parts = v1.split('.').map(Number);
  const v2Parts = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const val1 = v1Parts[i] || 0;
    const val2 = v2Parts[i] || 0;

    if (val1 > val2) return 1;
    if (val1 < val2) return -1;
  }
  return 0;
}

async function checkForUpdates() {
  try {
    const response = await fetch(GITHUB_MANIFEST_URL);
    if (!response.ok) return;

    const remoteManifest = await response.json();
    const localManifest = chrome.runtime.getManifest();

    if (compareVersions(remoteManifest.version, localManifest.version) > 0) {
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });

      // Store the update status to show a link in the popup
      chrome.storage.local.set({
        updateAvailable: true,
        newVersion: remoteManifest.version
      });
    }
  } catch (e) {
    console.error("Update check failed", e);
  }
}

// Check every 6 hours
chrome.alarms.create('updateCheck', { periodInMinutes: 360 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'updateCheck') {
    checkForUpdates();
  }
});

// Also check on startup
chrome.runtime.onStartup.addListener(() => {
  checkForUpdates();
});

// And on install/update of the extension itself
chrome.runtime.onInstalled.addListener(() => {
  checkForUpdates();
});
