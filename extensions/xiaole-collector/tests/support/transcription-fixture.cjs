const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clone = (value) => JSON.parse(JSON.stringify(value));
function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => { for (const fn of [...listeners]) fn(...args); } };
}

function fixture({ stored = {}, onFetch, stubRecordUpdates = true, stubBaseRequests = true } = {}) {
  const storage = clone(stored);
  const requests = [];
  const recordUpdates = [];
  const chrome = {
    runtime: { onMessage: event(), onInstalled: event(), onStartup: event() },
    alarms: { create() {}, onAlarm: event() },
    tabs: { onRemoved: event(), onUpdated: event(), query: async () => [] },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    storage: { local: {
      get: async (defaults) => clone({ ...defaults, ...storage }),
      set: async (values) => Object.assign(storage, clone(values)),
    } },
  };
  const context = vm.createContext({
    chrome, URL, URLSearchParams, console, AbortController, Blob, FormData, Uint8Array, crypto: require('node:crypto'),
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options = {}) => {
      const request = { url, ...options };
      requests.push(request);
      if (!onFetch) throw new Error('Unexpected network request in local fixture');
      return onFetch(request);
    },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../extensions/video-collector/background.js'), 'utf8'), context);
  if (stubRecordUpdates) context.updateTranscriptionRecord = async (job, status, text) => recordUpdates.push({ job: clone(job), status, text });
  // Keep UI/message tests offline; table scanning has separate production tests.
  if (stubBaseRequests) context.processBaseTranscriptionRequests = async () => ({ processed: 0 });
  return { api: context, chrome, storage, requests, recordUpdates,
    send: (message) => new Promise((resolve) => chrome.runtime.onMessage.emit(message, {}, resolve)) };
}

module.exports = { fixture, clone, response: (json, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => clone(json) }) };
