import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const POWER_SUPPLY_ROOT = '/sys/class/power_supply';

/**
 * Whether a Linux machine runs on battery, read from sysfs. Electron cannot
 * tell: its desktop-Linux power source is a stub that always reports AC.
 *
 * On battery means a system battery exists and no mains or USB supply is
 * online. A desktop with no supplies, a peripheral's battery (scope Device),
 * or files that cannot be read all count as plugged in.
 */
export function readLinuxOnBattery(root: string = POWER_SUPPLY_ROOT): boolean {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return false;
  }

  let hasSystemBattery = false;
  for (const name of names) {
    const type = readAttribute(root, name, 'type');
    if ((type === 'Mains' || type === 'USB') && readAttribute(root, name, 'online') === '1') return false;
    if (type === 'Battery' && readAttribute(root, name, 'scope') !== 'Device') hasSystemBattery = true;
  }
  return hasSystemBattery;
}

function readAttribute(root: string, supply: string, attribute: string): string | null {
  try {
    return readFileSync(join(root, supply, attribute), 'utf8').trim();
  } catch {
    return null;
  }
}
