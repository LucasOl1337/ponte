#!/usr/bin/env node
// Local control for SSH over Tailscale: run the same validated desktop actions
// Ponte exposes to the phone, from a shell on (or SSH'd into) this PC. Power,
// lock, unlock, monitor on/off and RGB presets, without the HTTP server.
//
//   ponte pc lock | unlock | sleep | wake | suspend | reboot | off
//   ponte pc monitors on|off [NAME]      (NAME omitted = all monitors)
//   ponte pc lights <lava|brasa|oceano|aurora|floresta|lua|sleep|restore>
//
// unlock reads the password from stdin (never argv, so it stays out of ps):
//   echo -n 'my password' | ponte pc unlock
import { createDesktop, LIGHT_PRESETS } from '../backend/desktop.mjs';
import { readFileSync } from 'node:fs';

const usage = `Usage: ponte pc <command>
  lock | unlock | sleep | wake | suspend | reboot | off
  monitors on|off [MONITOR]      (MONITOR omitted turns all monitors on/off)
  lights <${LIGHT_PRESETS.join('|')}|sleep|restore|reapply>
unlock reads the password from stdin: echo -n 'pw' | ponte pc unlock`;

function readStdin() {
  try { return readFileSync(0, 'utf8').replace(/\r?\n$/, ''); } catch { return ''; }
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') { console.log(usage); return command ? 0 : 2; }
  const desktop = createDesktop({});
  let action;
  switch (command) {
    case 'lock': action = { type: 'session.lock' }; break;
    case 'unlock': {
      const password = readStdin();
      if (!password) { console.error('No password on stdin. Use: echo -n \'pw\' | ponte pc unlock'); return 2; }
      action = { type: 'session.unlock', password };
      break;
    }
    case 'sleep': action = { type: 'power.sleep' }; break;
    case 'wake': action = { type: 'power.wake' }; break;
    case 'suspend': action = { type: 'power.suspend' }; break;
    case 'reboot': action = { type: 'power.reboot' }; break;
    case 'off': case 'poweroff': action = { type: 'power.off' }; break;
    case 'monitors': {
      const state = rest[0];
      if (state !== 'on' && state !== 'off') { console.error(usage); return 2; }
      action = rest[1] ? { type: 'power.dpms', monitor: rest[1], state } : { type: 'power.dpms_all', state };
      break;
    }
    case 'lights': {
      const which = rest[0];
      if (LIGHT_PRESETS.includes(which)) action = { type: 'lights.preset', preset: which };
      else if (['sleep', 'restore', 'reapply'].includes(which)) action = { type: `lights.${which}` };
      else { console.error(usage); return 2; }
      break;
    }
    default: console.error(usage); return 2;
  }
  try {
    await desktop.action(action);
    await desktop.close?.();
    console.log('ok');
    return 0;
  } catch (error) {
    await desktop.close?.().catch(() => {});
    console.error(error?.code ? `${error.code}: ${error.message}` : String(error?.message || error));
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
