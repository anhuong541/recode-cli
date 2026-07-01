import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import type { Project } from './project.js';
import type { Runtime } from './runtime.js';

export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface Alert {
  id: string;
  createdAt: string;
  status: AlertStatus;
  /** The pinned snapshot holding the last good state. */
  goodSnapshotId: string;
  /** The snapshot in which the anomaly was observed. */
  badSnapshotId: string;
  trigger: string;
  reasons: string[];
  resolvedAt?: string;
  resolution?: string;
}

interface AlertsFile {
  schemaVersion: 1;
  alerts: Alert[];
}

async function readAlertsFile(project: Project): Promise<AlertsFile> {
  const raw = await readJsonFile<AlertsFile>(project.alertsFile);
  return { schemaVersion: 1, alerts: raw?.alerts ?? [] };
}

export function isExpired(alert: Alert, rt: Runtime): boolean {
  return rt.now() - Date.parse(alert.createdAt) > rt.config.alerts.expireMs;
}

/** Alerts that still need attention: not resolved and younger than alerts.expireMs. */
export async function activeAlerts(rt: Runtime, project: Project): Promise<Alert[]> {
  const file = await readAlertsFile(project);
  return file.alerts.filter((a) => a.status !== 'resolved' && !isExpired(a, rt));
}

export async function allAlerts(project: Project): Promise<Alert[]> {
  return (await readAlertsFile(project)).alerts;
}

export async function addAlert(rt: Runtime, project: Project, alert: Omit<Alert, 'id' | 'createdAt' | 'status'>): Promise<Alert> {
  const file = await readAlertsFile(project);
  const full: Alert = {
    id: `al_${alert.badSnapshotId.replace(/^rc_/, '')}`,
    createdAt: new Date(rt.now()).toISOString(),
    status: 'open',
    ...alert,
  };
  // Drop expired alerts while we are here; the file only describes the recent past.
  file.alerts = file.alerts.filter((a) => !isExpired(a, rt) && a.id !== full.id);
  file.alerts.push(full);
  await writeJsonAtomic(project.alertsFile, file);
  return full;
}

export async function updateAlerts(
  rt: Runtime,
  project: Project,
  match: (a: Alert) => boolean,
  status: AlertStatus,
  resolution?: string,
): Promise<Alert[]> {
  const file = await readAlertsFile(project);
  const changed: Alert[] = [];
  for (const a of file.alerts) {
    if (a.status === 'resolved' || !match(a)) continue;
    a.status = status;
    if (status === 'resolved') {
      a.resolvedAt = new Date(rt.now()).toISOString();
      a.resolution = resolution;
    }
    changed.push(a);
  }
  if (changed.length > 0) await writeJsonAtomic(project.alertsFile, file);
  return changed;
}

export async function pruneAlerts(rt: Runtime, project: Project, existingIds: ReadonlySet<string>): Promise<void> {
  const file = await readAlertsFile(project);
  const kept = file.alerts.filter((a) => !isExpired(a, rt) && existingIds.has(a.goodSnapshotId));
  if (kept.length !== file.alerts.length) await writeJsonAtomic(project.alertsFile, { ...file, alerts: kept });
}
