/**
 * Shows an HTML file rendered in a browser tab: the tab already showing it, or a new
 * one. It never retargets a tab showing something else.
 */
import { panelApi } from '../../../services/panelApi';
import { activatePanel } from '../../../services/openFileInEditor';
import { usePanelStore } from '../../../stores/panelStore';

export async function previewHtmlFileInBrowser(sessionId: string, filePath: string): Promise<void> {
  const browserPanel = await panelApi.openHtmlFile(sessionId, filePath);
  usePanelStore.getState().addPanel(browserPanel);
  await activatePanel(sessionId, browserPanel.id);
}
