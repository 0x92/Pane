import { useEffect, useState } from 'react';
import { AlertCircle, Check, Trash2 } from 'lucide-react';
import { SettingsSection } from '../../ui/SettingsSection';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ConfirmDialog';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import {
  aliasInstallIdentity,
  aliasInstallIdentityDirect,
  aliasWebVisitor,
  aliasWebVisitorDirect,
  captureAndOptOut,
  captureUnconditionally,
  discardPendingEvents,
  flushPendingEvents,
  initPostHog,
} from '../../../services/posthog';
import type { AnalyticsIdentity } from '../../../types/config';

export function PrivacySettings({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  const analytics = config.analytics ?? { enabled: true };

  useEffect(() => {
    if (analytics.enabled) {
      void captureUnconditionally('analytics_settings_disclosure_viewed', { experiment: 'analytics_default_on' });
    }
  }, [analytics.enabled]);

  const resolveIdentity = async (): Promise<AnalyticsIdentity | undefined> => {
    try {
      const response = await window.electronAPI?.analytics?.getIdentity?.();
      return response?.success ? response.data : undefined;
    } catch {
      return undefined;
    }
  };

  const syncAnalytics = async (enabled: boolean, identity?: AnalyticsIdentity) => {
    initPostHog({
      enabled,
      posthogApiKey: analytics.posthogApiKey,
      posthogHost: analytics.posthogHost,
      identity,
    }, { flushPendingEvents: false });
    if (enabled) {
      aliasInstallIdentity(identity);
      if (identity?.webDistinctId) {
        aliasWebVisitor(identity.webDistinctId, identity.distinctId);
        void window.electronAPI?.analytics?.redeemAttribution?.();
      }
      await captureUnconditionally('analytics_opted_in', undefined, identity);
      flushPendingEvents();
      return;
    }
    await aliasInstallIdentityDirect(identity);
    if (identity?.webDistinctId) {
      await aliasWebVisitorDirect(identity);
      void window.electronAPI?.analytics?.redeemAttribution?.();
    }
    await captureAndOptOut('analytics_opted_out', undefined, identity);
    discardPendingEvents();
  };

  const saveAnalytics = async (enabled: boolean): Promise<boolean> => {
    const saved = await persistence.saveConfig('analytics', { analytics: { ...analytics, enabled } });
    if (!saved) return false;
    try {
      await syncAnalytics(enabled, await resolveIdentity());
      return true;
    } catch (error) {
      persistence.reportSaveError('analytics', error instanceof Error ? error.message : 'Analytics preference saved, but runtime sync failed');
      return true;
    }
  };

  return (
    <SettingsPage title="Privacy" description="Review and control what Pane shares.">
      <SettingsSection title="Analytics">
        <SettingRow
          settingId="analytics"
          label="Product analytics"
          description="Product analytics are on by default. Pane collects feature usage and may associate it with locally available GitHub or Git account details, such as a username or email. App error reports contain coarse error details and relative app stack locations. Pane never collects prompts, code, or repository paths. Turn this off to stop telemetry."
          saveState={persistence.saveStates.analytics}
        >
          <ImmediateToggle label="Allow product analytics" value={analytics.enabled === true} onSave={saveAnalytics} />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Browser">
        <BrowserDataSetting />
      </SettingsSection>
    </SettingsPage>
  );
}

type ClearBrowserDataOutcome = { kind: 'success' | 'failure'; message: string };

/** Asks this computer's main process to sign out of every site in Pane's browser. */
export async function clearBrowserData(
  invoke: (channel: string) => Promise<void> = channel => window.electronAPI.invoke(channel),
): Promise<ClearBrowserDataOutcome> {
  try {
    await invoke('browser-data:clear');
    return { kind: 'success', message: "Browser data cleared. You're signed out of every site in Pane's browser." };
  } catch (error) {
    return { kind: 'failure', message: ipcErrorMessage(error, "Pane couldn't clear its browser data. Try Clear browser data again.") };
  }
}

export function BrowserDataSetting() {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [outcome, setOutcome] = useState<ClearBrowserDataOutcome | null>(null);

  const clear = async () => {
    setClearing(true);
    setOutcome(null);
    setOutcome(await clearBrowserData());
    setClearing(false);
  };

  return (
    <SettingRow
      settingId="browser-data"
      label="Browser data"
      description="Pane's browser keeps one set of logins, cookies and site data for every project and Session."
    >
      <div className="flex flex-col gap-1.5 sm:items-end">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Trash2 className="h-4 w-4" />}
          loading={clearing}
          loadingText="Clearing"
          onClick={() => setConfirming(true)}
        >
          Clear browser data
        </Button>
        {outcome?.kind === 'success' && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success" aria-live="polite">
            <Check className="h-3 w-3 flex-none" /> {outcome.message}
          </span>
        )}
        {outcome?.kind === 'failure' && (
          <span className="flex max-w-sm items-start gap-1 text-xs text-status-error" role="alert">
            <AlertCircle className="mt-0.5 h-3 w-3 flex-none" /> {outcome.message}
          </span>
        )}
      </div>
      <ConfirmDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void clear()}
        title="Clear browser data?"
        message="This signs you out of every site in Pane's browser, including GitHub and Grain, and removes their cookies, site data and cache. Open browser tabs will reload. This can't be undone."
        confirmText="Clear browser data"
        variant="danger"
      />
    </SettingRow>
  );
}
