import { readFileSync } from 'fs';

/** @returns {{ memAvailableKb: number, memTotalKb: number, load1: number }} */
export function systemPressure() {
  const meminfo = readFileSync('/proc/meminfo', 'utf8');
  const avail = Number((/MemAvailable:\s+(\d+)/.exec(meminfo) || [])[1] || 0);
  const total = Number((/MemTotal:\s+(\d+)/.exec(meminfo) || [])[1] || 0);
  let load1 = 0;
  try {
    load1 = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0] || 0);
  } catch (_) {}
  return { memAvailableKb: avail, memTotalKb: total, load1 };
}

export function memoryOk(minAvailableKb) {
  const { memAvailableKb } = systemPressure();
  return {
    ok: memAvailableKb >= minAvailableKb,
    memAvailableKb,
    memAvailableMiB: Math.round(memAvailableKb / 1024),
  };
}
