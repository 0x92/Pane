/**
 * Opens an HTML file rendered in a new browser tab. It never retargets an open tab.
 */
import { panelApi } from '../../../services/panelApi';
import { usePanelStore } from '../../../stores/panelStore';

export async function previewHtmlFileInBrowser(sessionId: string, filePath: string): Promise<void> {
  const browserPanel = await panelApi.openHtmlFile(sessionId, filePath);
  const store = usePanelStore.getState();
  store.addPanel(browserPanel);
  store.setActivePanel(sessionId, browserPanel.id);
  await panelApi.setActivePanel(sessionId, browserPanel.id);
}
