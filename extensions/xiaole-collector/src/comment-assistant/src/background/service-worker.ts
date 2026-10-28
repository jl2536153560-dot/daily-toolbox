const ACTIVATE_MESSAGE = { type: "DCS_ACTIVATE_TOOLBAR" } as const;

let sessionEpoch: Promise<string> | null = null;
function getSessionEpoch(): Promise<string> {
  return sessionEpoch ??= chrome.storage.session.get('commentSessionEpoch').then(async value => {
    if (typeof value.commentSessionEpoch === 'string') return value.commentSessionEpoch;
    const epoch = crypto.randomUUID(); await chrome.storage.session.set({commentSessionEpoch:epoch}); return epoch;
  });
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'XIAOLE_COMMENT_SESSION') return false;
  if (sender.id !== chrome.runtime.id || !sender.tab?.id || !isDouyinUrl(sender.url)) { respond({ok:false}); return false; }
  void getSessionEpoch().then(epoch => respond({ok:true, key:`${epoch}:${sender.tab!.id}`}), () => respond({ok:false}));
  return true;
});

function isDouyinUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === "www.douyin.com";
  } catch {
    return false;
  }
}

async function injectContentAssets(tabId: number): Promise<void> {
  const manifest = chrome.runtime.getManifest();
  const contentScript = manifest.content_scripts?.find((entry) =>
    entry.matches?.some((pattern) => pattern.includes("douyin.com"))
  );
  if (!contentScript?.js?.length) {
    throw new Error("未找到评论读取程序。");
  }

  if (contentScript.css?.length) {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: contentScript.css
    });
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: contentScript.js
  });
}

async function activateToolbar(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id || !isDouyinUrl(tab.url)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, ACTIVATE_MESSAGE);
  } catch {
    await injectContentAssets(tab.id);
    await chrome.tabs.sendMessage(tab.id, ACTIVATE_MESSAGE);
  }
}

chrome.action.onClicked.addListener((tab) => {
  void activateToolbar(tab);
});
