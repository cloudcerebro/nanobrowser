import { createLogger } from '@src/background/log';

const logger = createLogger('DebuggerManager');

interface DebuggerState {
  isAttaching: boolean;
  isDetaching: boolean;
  isAttached: boolean;
  lastOperation: 'attach' | 'detach' | 'none';
  timestamp: number;
}

class DebuggerManager {
  private static instance: DebuggerManager;
  private tabStates = new Map<number, DebuggerState>();

  private constructor() {
    // Listen to debugger events to track state changes
    chrome.debugger.onEvent.addListener(this.handleDebuggerEvent.bind(this));
    chrome.debugger.onDetach.addListener(this.handleDebuggerDetach.bind(this));
  }

  public static getInstance(): DebuggerManager {
    if (!DebuggerManager.instance) {
      DebuggerManager.instance = new DebuggerManager();
    }
    return DebuggerManager.instance;
  }

  private handleDebuggerEvent(source: chrome.debugger.Debuggee, method: string) {
    if (source.tabId) {
      logger.info(`Debugger event for tab ${source.tabId}: ${method}`);
    }
  }

  private handleDebuggerDetach(source: chrome.debugger.Debuggee, reason: chrome.debugger.DetachReason) {
    if (source.tabId) {
      logger.info(`Debugger detached from tab ${source.tabId}: ${reason}`);
      this.updateState(source.tabId, { isAttached: false, isDetaching: false, lastOperation: 'detach' });
    }
  }

  public updateState(tabId: number, updates: Partial<DebuggerState>) {
    const current = this.tabStates.get(tabId) || {
      isAttaching: false,
      isDetaching: false,
      isAttached: false,
      lastOperation: 'none',
      timestamp: Date.now(),
    };

    this.tabStates.set(tabId, {
      ...current,
      ...updates,
      timestamp: Date.now(),
    });
  }

  private getState(tabId: number): DebuggerState {
    return (
      this.tabStates.get(tabId) || {
        isAttaching: false,
        isDetaching: false,
        isAttached: false,
        lastOperation: 'none',
        timestamp: Date.now(),
      }
    );
  }

  public async attachDebugger(tabId: number): Promise<boolean> {
    const state = this.getState(tabId);
    logger.info(`[DebuggerManager] attachDebugger called for tab ${tabId}, current state:`, state);

    // If already attaching or attached, wait or return
    if (state.isAttaching) {
      logger.info(`[DebuggerManager] Tab ${tabId} already attaching, waiting...`);
      await this.waitForOperation(tabId, 'attach');
      const finalState = this.getState(tabId);
      logger.info(`[DebuggerManager] Wait completed for tab ${tabId}, final state:`, finalState);
      return finalState.isAttached;
    }

    if (state.isAttached) {
      logger.info(`[DebuggerManager] Tab ${tabId} already attached`);
      return true;
    }

    logger.info(`[DebuggerManager] Starting attach process for tab ${tabId}`);
    this.updateState(tabId, { isAttaching: true });

    try {
      // Check current state from Chrome
      const targets = await chrome.debugger.getTargets();
      const existingTarget = targets.find(target => target.tabId === tabId && target.attached);

      if (existingTarget) {
        logger.info(`[DebuggerManager] Debugger already attached to tab ${tabId} by Chrome, detaching first`);
        await this.detachDebugger(tabId);
        // Small delay to ensure detachment completes
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Attempt to attach
      logger.info(`[DebuggerManager] Attempting to attach debugger to tab ${tabId}`);
      await chrome.debugger.attach({ tabId }, '1.3');
      this.updateState(tabId, { isAttaching: false, isAttached: true, lastOperation: 'attach' });
      logger.info(`[DebuggerManager] Successfully attached debugger to tab ${tabId}`);
      return true;
    } catch (error) {
      this.updateState(tabId, { isAttaching: false, isAttached: false, lastOperation: 'attach' });
      logger.error(`[DebuggerManager] Failed to attach debugger to tab ${tabId}:`, error);
      return false;
    }
  }

  public async detachDebugger(tabId: number): Promise<void> {
    const state = this.getState(tabId);
    logger.info(`[DebuggerManager] detachDebugger called for tab ${tabId}, current state:`, state);

    // If already detaching, wait for completion
    if (state.isDetaching) {
      logger.info(`[DebuggerManager] Tab ${tabId} already detaching, waiting...`);
      await this.waitForOperation(tabId, 'detach');
      return;
    }

    if (!state.isAttached) {
      // Check Chrome state to be sure
      const targets = await chrome.debugger.getTargets();
      const existingTarget = targets.find(target => target.tabId === tabId && target.attached);
      if (!existingTarget) {
        logger.info(`[DebuggerManager] Tab ${tabId} already detached`);
        return;
      }
    }

    logger.info(`[DebuggerManager] Starting detach process for tab ${tabId}`);
    this.updateState(tabId, { isDetaching: true });

    try {
      await chrome.debugger.detach({ tabId });
      this.updateState(tabId, { isDetaching: false, isAttached: false, lastOperation: 'detach' });
      logger.info(`[DebuggerManager] Successfully detached debugger from tab ${tabId}`);
    } catch (error) {
      this.updateState(tabId, { isDetaching: false, lastOperation: 'detach' });
      logger.error(`[DebuggerManager] Failed to detach debugger from tab ${tabId}:`, error);
    }
  }

  public async forceDetachAll(): Promise<void> {
    logger.info('[DebuggerManager] Force detaching all debuggers');

    try {
      const targets = await chrome.debugger.getTargets();
      const attachedTargets = targets.filter(target => target.attached && target.tabId);

      logger.info(`[DebuggerManager] Found ${attachedTargets.length} attached debuggers to detach`);

      const detachPromises = attachedTargets.map(async target => {
        if (target.tabId) {
          try {
            logger.info(`[DebuggerManager] Force detaching debugger from tab ${target.tabId}`);
            await chrome.debugger.detach({ tabId: target.tabId });
            this.updateState(target.tabId, {
              isAttaching: false,
              isDetaching: false,
              isAttached: false,
              lastOperation: 'detach',
            });
            logger.info(`[DebuggerManager] Successfully force detached debugger from tab ${target.tabId}`);
          } catch (error) {
            logger.error(`[DebuggerManager] Failed to force detach debugger from tab ${target.tabId}:`, error);
          }
        }
      });

      await Promise.allSettled(detachPromises);
      logger.info('[DebuggerManager] Force detach completed');
    } catch (error) {
      logger.error('[DebuggerManager] Error during force detach all:', error);
    }
  }

  private async waitForOperation(tabId: number, operation: 'attach' | 'detach', timeout = 5000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const state = this.getState(tabId);

      if (operation === 'attach' && !state.isAttaching) {
        return;
      }
      if (operation === 'detach' && !state.isDetaching) {
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.warn(`Timeout waiting for ${operation} operation on tab ${tabId}`);
  }

  public isTabBusy(tabId: number): boolean {
    const state = this.getState(tabId);
    return state.isAttaching || state.isDetaching;
  }

  public clearTabState(tabId: number): void {
    this.tabStates.delete(tabId);
  }

  public async attachPuppeteerDebugger(tabId: number): Promise<boolean> {
    // Mark as busy to prevent concurrent operations
    this.updateState(tabId, { isAttaching: true });

    try {
      // First ensure any existing debugger is detached
      const targets = await chrome.debugger.getTargets();
      const existingTarget = targets.find(target => target.tabId === tabId && target.attached);

      if (existingTarget) {
        logger.info(`[DebuggerManager] Existing debugger found on tab ${tabId}, detaching first`);
        try {
          await chrome.debugger.detach({ tabId });
          // Wait a bit for the detachment to be processed
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (detachError) {
          logger.error(`[DebuggerManager] Failed to detach existing debugger from tab ${tabId}:`, detachError);
        }
      }

      // Mark as successfully attached (Puppeteer will handle the actual attachment)
      this.updateState(tabId, {
        isAttaching: false,
        isAttached: true,
        lastOperation: 'attach',
      });

      return true;
    } catch (error) {
      // Mark as failed
      this.updateState(tabId, {
        isAttaching: false,
        isAttached: false,
        lastOperation: 'attach',
      });
      logger.error(`[DebuggerManager] Failed to prepare debugger for tab ${tabId}:`, error);
      return false;
    }
  }

  public async detachPuppeteerDebugger(tabId: number): Promise<void> {
    // Mark as detaching to prevent concurrent operations
    this.updateState(tabId, { isDetaching: true });

    try {
      // Try to detach debugger if still attached
      const targets = await chrome.debugger.getTargets();
      const isAttached = targets.some(target => target.tabId === tabId && target.attached);
      if (isAttached) {
        await chrome.debugger.detach({ tabId });
      }
    } catch (error) {
      logger.error(`[DebuggerManager] Failed to detach debugger from tab ${tabId}:`, error);
    }

    // Mark as detached
    this.updateState(tabId, {
      isDetaching: false,
      isAttached: false,
      lastOperation: 'detach',
    });
  }
}

export default DebuggerManager;
