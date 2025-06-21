import 'webextension-polyfill';
import {
  type BrowserContextConfig,
  type BrowserState,
  DEFAULT_BROWSER_CONTEXT_CONFIG,
  type TabInfo,
  URLNotAllowedError,
} from './views';
import Page, { build_initial_state } from './page';
import { createLogger } from '@src/background/log';
import { isUrlAllowed } from './util';
import DebuggerManager from './debuggerManager';

const logger = createLogger('BrowserContext');
export default class BrowserContext {
  private _config: BrowserContextConfig;
  private _currentTabId: number | null = null;
  private _attachedPages: Map<number, Page> = new Map();
  private _debuggerManager: DebuggerManager;
  private _pageCreationLocks: Map<number, Promise<Page>> = new Map();

  constructor(config: Partial<BrowserContextConfig>) {
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
    this._debuggerManager = DebuggerManager.getInstance();
  }

  public getConfig(): BrowserContextConfig {
    return this._config;
  }

  public updateConfig(config: Partial<BrowserContextConfig>): void {
    this._config = { ...this._config, ...config };
  }

  public updateCurrentTabId(tabId: number): void {
    // only update tab id, but don't attach it.
    this._currentTabId = tabId;
  }

  private async _getOrCreatePage(tab: chrome.tabs.Tab): Promise<Page> {
    if (!tab.id) {
      throw new Error('Tab ID is not available');
    }

    // Check if another call is already creating a page for this tab
    const existingLock = this._pageCreationLocks.get(tab.id);
    if (existingLock) {
      logger.info('getOrCreatePage', tab.id, 'waiting for existing page creation to complete');
      return await existingLock;
    }

    let page = this._attachedPages.get(tab.id);
    if (page) {
      // Check if debugger manager thinks this tab is busy
      if (this._debuggerManager.isTabBusy(tab.id)) {
        logger.info('getOrCreatePage', tab.id, 'tab is busy with debugger operation, waiting...');
        // Wait for the operation to complete before proceeding
        let attempts = 0;
        while (this._debuggerManager.isTabBusy(tab.id) && attempts < 20) {
          await new Promise(resolve => setTimeout(resolve, 250));
          attempts++;
        }
      }

      // Re-check the page after potential wait
      page = this._attachedPages.get(tab.id);
      if (page && page.attached) {
        logger.info('getOrCreatePage', tab.id, 'found existing connected page');
        return page;
      } else if (page) {
        // Page exists but not attached - remove it and create new one
        logger.info('getOrCreatePage', tab.id, 'existing page not connected, removing');
        await this.detachPage(tab.id);
      }
    }

    // Create a lock promise for this tab to prevent concurrent page creation
    const pageCreationPromise = this._createPageWithLock(tab);
    this._pageCreationLocks.set(tab.id, pageCreationPromise);

    try {
      return await pageCreationPromise;
    } finally {
      // Remove the lock when done
      this._pageCreationLocks.delete(tab.id);
    }
  }

  private async _createPageWithLock(tab: chrome.tabs.Tab): Promise<Page> {
    if (!tab.id) {
      throw new Error('Tab ID is not available');
    }

    // Check if tab is busy before creating new page
    if (this._debuggerManager.isTabBusy(tab.id)) {
      logger.info('getOrCreatePage', tab.id, 'tab still busy, forcing wait...');
      let attempts = 0;
      while (this._debuggerManager.isTabBusy(tab.id) && attempts < 20) {
        await new Promise(resolve => setTimeout(resolve, 250));
        attempts++;
      }
    }

    logger.info('getOrCreatePage', tab.id, 'creating new page instance');
    const page = new Page(tab.id, tab.url || '', tab.title || '', this._config);
    // Do not add to map here. Add it only after successful attachment.
    return page;
  }

  public async cleanup(): Promise<void> {
    try {
      const currentPage = this._currentTabId ? this._attachedPages.get(this._currentTabId) : null;
      if (currentPage) {
        await currentPage.removeHighlight();
      }
    } catch (error) {
      logger.error('Error removing highlight during cleanup:', error);
    }

    // Clear debugger state for all attached tabs
    for (const tabId of this._attachedPages.keys()) {
      this._debuggerManager.clearTabState(tabId);
    }

    // detach all pages with proper error handling
    const detachPromises = Array.from(this._attachedPages.values()).map(async page => {
      try {
        await page.detachPuppeteer();
      } catch (error) {
        logger.error(`Error detaching page ${page.tabId}:`, error);
        // If page detachment fails, try force detach through debugger manager
        try {
          await this._debuggerManager.detachDebugger(page.tabId);
        } catch (debuggerError) {
          logger.error(`Error force detaching debugger for tab ${page.tabId}:`, debuggerError);
        }
      }
    });

    await Promise.allSettled(detachPromises);
    this._attachedPages.clear();
    this._pageCreationLocks.clear();
    this._currentTabId = null;
  }

  public async attachPage(page: Page): Promise<boolean> {
    // check if page is already attached
    if (this._attachedPages.has(page.tabId)) {
      const existingPage = this._attachedPages.get(page.tabId);
      if (existingPage && existingPage.attached) {
        logger.info('attachPage', page.tabId, 'already attached and connected');
        return true;
      }
      // If page exists but not attached, remove it and try again
      logger.info('attachPage', page.tabId, 'existing page not connected, replacing');
      await this.detachPage(page.tabId);
    }

    if (await page.attachPuppeteer()) {
      logger.info('attachPage', page.tabId, 'attached');
      // add page to managed pages
      this._attachedPages.set(page.tabId, page);
      return true;
    }
    return false;
  }

  public async detachPage(tabId: number): Promise<void> {
    // detach page
    const page = this._attachedPages.get(tabId);
    if (page) {
      await page.detachPuppeteer();
      // remove page from managed pages
      this._attachedPages.delete(tabId);
    }
  }

  public async getCurrentPage(forceNewTab = false): Promise<Page> {
    // 1. If forceNewTab is true, always create a new tab
    if (forceNewTab) {
      const newTab = await chrome.tabs.create({ url: this._config.homePageUrl, active: true });
      if (!newTab.id) {
        throw new Error('No tab ID available');
      }
      logger.info('force new tab', newTab.id);
      const page = await this._getOrCreatePage(newTab);
      await this.attachPage(page);
      this._currentTabId = newTab.id;
      return page;
    }

    // 2. If _currentTabId not set, query the active tab and attach it
    if (!this._currentTabId) {
      let activeTab: chrome.tabs.Tab;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        // open a new tab with blank page
        const newTab = await chrome.tabs.create({ url: this._config.homePageUrl });
        if (!newTab.id) {
          // this should rarely happen
          throw new Error('No tab ID available');
        }
        activeTab = newTab;
      } else {
        activeTab = tab;
      }
      logger.info('active tab', activeTab.id, activeTab.url, activeTab.title);
      const page = await this._getOrCreatePage(activeTab);
      await this.attachPage(page);
      this._currentTabId = activeTab.id || null;
      return page;
    }

    // 3. If _currentTabId is set but not in attachedPages, attach the tab
    let page = this._attachedPages.get(this._currentTabId);
    if (!page) {
      const tab = await chrome.tabs.get(this._currentTabId);
      page = await this._getOrCreatePage(tab);
      // set current tab id to null if the page is not attached successfully
      await this.attachPage(page);
    }

    // 4. Return existing page from attachedPages
    return page;
  }

  /**
   * Get all tab IDs from the browser and the current window.
   * @returns A set of tab IDs.
   */
  public async getAllTabIds(): Promise<Set<number>> {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return new Set(tabs.map(tab => tab.id).filter(id => id !== undefined));
  }

  /**
   * Wait for tab events to occur after a tab is created or updated.
   * @param tabId - The ID of the tab to wait for events on.
   * @param options - An object containing options for the wait.
   * @returns A promise that resolves when the tab events occur.
   */
  private async waitForTabEvents(
    tabId: number,
    options: {
      waitForUpdate?: boolean;
      waitForActivation?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    const { waitForUpdate = true, waitForActivation = true, timeoutMs = 5000 } = options;

    const promises: Promise<void>[] = [];

    if (waitForUpdate) {
      const updatePromise = new Promise<void>(resolve => {
        let hasUrl = false;
        let hasTitle = false;
        let isComplete = false;

        const onUpdatedHandler = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
          if (updatedTabId !== tabId) return;

          if (changeInfo.url) hasUrl = true;
          if (changeInfo.title) hasTitle = true;
          if (changeInfo.status === 'complete') isComplete = true;

          // Resolve when we have all the information we need
          if (hasUrl && hasTitle && isComplete) {
            chrome.tabs.onUpdated.removeListener(onUpdatedHandler);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(onUpdatedHandler);

        // Check current state
        chrome.tabs.get(tabId).then(tab => {
          if (tab.url) hasUrl = true;
          if (tab.title) hasTitle = true;
          if (tab.status === 'complete') isComplete = true;

          if (hasUrl && hasTitle && isComplete) {
            chrome.tabs.onUpdated.removeListener(onUpdatedHandler);
            resolve();
          }
        });
      });
      promises.push(updatePromise);
    }

    if (waitForActivation) {
      const activatedPromise = new Promise<void>(resolve => {
        const onActivatedHandler = (activeInfo: chrome.tabs.TabActiveInfo) => {
          if (activeInfo.tabId === tabId) {
            chrome.tabs.onActivated.removeListener(onActivatedHandler);
            resolve();
          }
        };
        chrome.tabs.onActivated.addListener(onActivatedHandler);

        // Check current state
        chrome.tabs.get(tabId).then(tab => {
          if (tab.active) {
            chrome.tabs.onActivated.removeListener(onActivatedHandler);
            resolve();
          }
        });
      });
      promises.push(activatedPromise);
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tab operation timed out after ${timeoutMs} ms`)), timeoutMs),
    );

    await Promise.race([Promise.all(promises), timeoutPromise]);
  }

  public async switchTab(tabId: number): Promise<Page> {
    logger.info('switchTab', tabId);

    await chrome.tabs.update(tabId, { active: true });
    await this.waitForTabEvents(tabId, { waitForUpdate: false });

    const page = await this._getOrCreatePage(await chrome.tabs.get(tabId));
    await this.attachPage(page);
    this._currentTabId = tabId;
    return page;
  }

  public async navigateTo(url: string): Promise<void> {
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }

    const page = await this.getCurrentPage();
    if (!page) {
      await this.openTab(url);
      return;
    }
    // if page is attached, use puppeteer to navigate to the url
    if (page.attached) {
      await page.navigateTo(url);
      return;
    }
    //  Use chrome.tabs.update only if the page is not attached
    const tabId = page.tabId;
    // Update tab and wait for events
    await chrome.tabs.update(tabId, { url, active: true });
    await this.waitForTabEvents(tabId);

    // Reattach the page after navigation completes
    const updatedPage = await this._getOrCreatePage(await chrome.tabs.get(tabId));
    await this.attachPage(updatedPage);
    this._currentTabId = tabId;
  }

  public async openTab(url: string): Promise<Page> {
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`Open tab failed. URL: ${url} is not allowed`);
    }

    // Create the new tab
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab.id) {
      throw new Error('No tab ID available');
    }
    // Wait for tab events
    await this.waitForTabEvents(tab.id);

    // Get updated tab information
    const updatedTab = await chrome.tabs.get(tab.id);
    // Create and attach the page after tab is fully loaded and activated
    const page = await this._getOrCreatePage(updatedTab);
    await this.attachPage(page);
    this._currentTabId = tab.id;

    return page;
  }

  public async closeTab(tabId: number): Promise<void> {
    await this.detachPage(tabId);
    await chrome.tabs.remove(tabId);
    // update current tab id if needed
    if (this._currentTabId === tabId) {
      this._currentTabId = null;
    }
  }

  /**
   * Remove a tab from the attached pages map. This will not run detachPuppeteer.
   * @param tabId - The ID of the tab to remove.
   */
  public removeAttachedPage(tabId: number): void {
    this._attachedPages.delete(tabId);
    // update current tab id if needed
    if (this._currentTabId === tabId) {
      this._currentTabId = null;
    }
  }

  public async getTabInfos(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    const tabInfos: TabInfo[] = [];

    for (const tab of tabs) {
      if (tab.id && tab.url && tab.title) {
        tabInfos.push({
          id: tab.id,
          url: tab.url,
          title: tab.title,
        });
      }
    }
    return tabInfos;
  }

  public async getState(useVision = false, cacheClickableElementsHashes = false): Promise<BrowserState> {
    const currentPage = await this.getCurrentPage();

    const pageState = !currentPage
      ? build_initial_state()
      : await currentPage.getState(useVision, cacheClickableElementsHashes);
    const tabInfos = await this.getTabInfos();
    const browserState: BrowserState = {
      ...pageState,
      tabs: tabInfos,
      browser_errors: [],
    };
    return browserState;
  }

  public async removeHighlight(): Promise<void> {
    const page = await this.getCurrentPage();
    if (page) {
      await page.removeHighlight();
    }
  }
}
