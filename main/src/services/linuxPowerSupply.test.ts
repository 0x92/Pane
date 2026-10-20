import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLinuxOnBattery } from './linuxPowerSupply';

describe('readLinuxOnBattery', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pane-power-supply-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function supply(name: string, files: Record<string, string>): void {
    mkdirSync(join(root, name));
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(root, name, file), `${content}\n`);
    }
  }

  it('reads plugged in when mains power is online', () => {
    supply('AC', { type: 'Mains', online: '1' });
    supply('BAT0', { type: 'Battery', status: 'Charging' });

    expect(readLinuxOnBattery(root)).toBe(false);
  });

  it('reads battery when the battery is the only online source', () => {
    supply('AC', { type: 'Mains', online: '0' });
    supply('BAT0', { type: 'Battery', status: 'Discharging' });

    expect(readLinuxOnBattery(root)).toBe(true);
  });

  it('reads battery when a laptop lists only its battery', () => {
    supply('BAT0', { type: 'Battery' });

    expect(readLinuxOnBattery(root)).toBe(true);
  });

  it('reads plugged in when USB-C power is online', () => {
    supply('ucsi-source-psy-USBC000-001', { type: 'USB', online: '1' });
    supply('BAT1', { type: 'Battery' });

    expect(readLinuxOnBattery(root)).toBe(false);
  });

  it('reads plugged in on a desktop with no power supplies', () => {
    expect(readLinuxOnBattery(root)).toBe(false);
  });

  it("ignores a wireless mouse's battery on a desktop", () => {
    supply('hidpp_battery_0', { type: 'Battery', scope: 'Device' });

    expect(readLinuxOnBattery(root)).toBe(false);
  });

  it('reads plugged in when the power supply folder cannot be read', () => {
    expect(readLinuxOnBattery(join(root, 'missing'))).toBe(false);
  });

  it('skips a supply whose files cannot be read', () => {
    mkdirSync(join(root, 'BROKEN'));
    supply('AC', { type: 'Mains', online: '1' });
    supply('BAT0', { type: 'Battery' });

    expect(readLinuxOnBattery(root)).toBe(false);
  });
});
