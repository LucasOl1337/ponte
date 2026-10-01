// The optional Hyprland module that lets Super reach the controlled device.
// Runs only where Hyprland is installed, always on a copy (HYPR_DIR), never on
// the live config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'tools/hypr/ponte-rd-hypr.sh');
const module = readFileSync(path.join(root, 'tools/hypr/ponte_rd.lua'), 'utf8');
const hasHyprland = spawnSync('Hyprland', ['--version']).status === 0;
const luaInterpreters = ['lua', 'lua5.4'].filter(command => spawnSync(command, ['-v']).status === 0);

test('the Lua module uses the same title mark and RD class as the page', () => {
  const client = readFileSync(path.join(root, 'public/rd.js'), 'utf8');
  const mark = client.match(/TITLE_MARK = '([^']+)'/)[1];
  assert.ok(module.includes(`local MARK = "${mark}"`), 'same mark on both sides');
  assert.match(module, /class == "ponte-rd"/, 'matches the window `ponte rd` opens');
});

// Hyprland 0.56.2 (efb50993780079460b0cbed1363e2166a2de1d9f):
// LuaEventHandler.cpp:99-106 passes Window directly (+ integer reason on active).
// LuaWindow.cpp:59-73,105-110,240-257 exposes live fields through userdata __index.
// These proxies exercise our module, not C++ userdata or actual key delivery.
const luaHarness = String.raw`
local module = assert(arg[1])
local function window(class, title, address)
  local fields = { class = class or "ponte-rd", title = title or "⌨ notebook · Ponte",
    address = address or "0x1", mapped = true, active = false }
  return setmetatable({}, { __index = function(_, key) return fields[key] end }), fields
end
local function setup(submap, active)
  local s = { submap = submap or "", active = active, events = {}, binds = {}, calls = {} }
  hl = {
    dsp = { submap = function(name) return { name = name } end },
    get_active_window = function() return s.active end,
    get_current_submap = function() return s.submap end,
    dispatch = function(d)
      s.calls[#s.calls + 1] = d.name
      s.submap = d.name == "reset" and "" or d.name
    end,
    on = function(name, fn) s.events[name] = fn end,
    define_submap = function(name, fn) s.defining = name; fn(); s.defining = nil end,
    bind = function(keys, fn, opts) s.binds[keys] = { fn = fn, opts = opts, submap = s.defining } end,
  }
  dofile(module)
  function s:event(name, ...) assert(self.events[name], "missing listener: " .. name)(...) end
  function s:focus(w, fields)
    self.active = w
    if fields then fields.active = true end
    self:event("window.active", w, 0)
  end
  function s:emergency()
    local bind = assert(self.binds["SUPER + CTRL + ALT + ESCAPE"])
    assert(bind.submap == "ponte-rd" and bind.opts.dont_inhibit == true)
    bind.fn()
  end
  return s
end
local function equal(a, b) assert(a == b, "expected " .. tostring(b) .. ", got " .. tostring(a)) end
local function scenario(name, fn) fn(); print("PASS " .. name) end

scenario("direct Window + reason enters idempotently; title removal exits", function()
  local s = setup()
  local w, f = window()
  s:focus(w, f)
  equal(s.submap, "ponte-rd")
  s:focus(w, f)
  equal(#s.calls, 1)
  f.title = "Ponte"
  s:event("window.title", w)
  equal(s.submap, "")
  equal(s.calls[2], "reset")
  s:event("window.title", w)
  equal(#s.calls, 2)
  f.title = "⌨ notebook · Ponte"
  s:event("window.title", w)
  equal(s.submap, "ponte-rd")
end)
scenario("Chrome RD matches, ordinary class and near-prefix do not", function()
  local s = setup()
  local w, f = window("chrome-ponte__rd.html-Default")
  s:focus(w, f)
  equal(s.submap, "ponte-rd")
  f.title = "⌨notebook"
  s:event("window.title", w)
  equal(s.submap, "")
  local other, of = window("terminal")
  s:focus(other, of)
  equal(s.submap, "")
end)
scenario("focus change releases; background title cannot capture", function()
  local s = setup()
  local w, f = window()
  s:focus(w, f)
  f.active = false
  local other, of = window("terminal", "shell", "0x2")
  s:focus(other, of)
  equal(s.submap, "")
  s:event("window.title", w)
  equal(s.submap, "")
  s.active = nil
  s:event("window.title", w)
  equal(s.submap, "")
end)
scenario("focus lost as nil or empty/expired userdata proxy releases", function()
  local s = setup()
  local w, f = window()
  s:focus(w, f)
  s:focus(nil)
  equal(s.submap, "")
  s:focus(w, f)
  s:focus(setmetatable({}, { __index = function() return nil end }))
  equal(s.submap, "")
end)
scenario("closing owner releases before unmapped active event and never rearms", function()
  local s = setup()
  local w, f = window()
  s:focus(w, f)
  s:event("window.close", w)
  equal(s.submap, "")
  -- Window.cpp:2628,2644,2685: reset focus, unmap, active(closing Window).
  s.active = nil
  f.mapped = false
  f.active = false
  s:event("window.active", w, 0)
  s:event("window.title", w)
  equal(s.submap, "")
end)
scenario("closing a background RD does not release the current owner", function()
  local s = setup()
  local w, f = window()
  s:focus(w, f)
  local other = window("ponte-rd", nil, "0x2")
  s:event("window.close", other)
  equal(s.submap, "ponte-rd")
  s:event("window.title", other)
  equal(s.submap, "ponte-rd")
end)
scenario("mapped and active are independently required even on active events", function()
  local s = setup()
  local w, f = window()
  f.active = true
  f.mapped = false
  s:event("window.active", w, 0)
  equal(s.submap, "")
  f.mapped = true
  f.active = false
  s:event("window.active", w, 0)
  equal(s.submap, "")
end)
scenario("focus transfers ownership between two controlling RDs", function()
  local s = setup()
  local a, af = window()
  s:focus(a, af)
  af.active = false
  local b, bf = window("ponte-rd", nil, "0x2")
  s:focus(b, bf)
  equal(#s.calls, 1)
  s:event("window.close", a)
  equal(s.submap, "ponte-rd")
  s:event("window.close", b)
  equal(s.submap, "")
end)
scenario("emergency blocks title and focus reentry until mark is removed", function()
  local s = setup()
  local w, f = window()
  s:focus(w, f)
  s:emergency()
  equal(s.submap, "")
  f.title = "⌨ renamed notebook · Ponte"
  s:event("window.title", w)
  s:focus(w, f)
  equal(s.submap, "")
  f.title = "Ponte"
  s:event("window.title", w)
  f.title = "⌨ notebook · Ponte"
  s:event("window.title", w)
  equal(s.submap, "ponte-rd")
end)
scenario("another RD can control while emergency blocks only the old owner", function()
  local s = setup()
  local a, af = window()
  s:focus(a, af)
  s:emergency()
  af.active = false
  local b, bf = window("ponte-rd", nil, "0x2")
  s:focus(b, bf)
  equal(s.submap, "ponte-rd")
  s:event("window.title", a)
  equal(s.submap, "ponte-rd")
  s:event("window.close", a)
  equal(s.submap, "ponte-rd")
  s:event("window.close", b)
  equal(s.submap, "")
end)
scenario("background title removal clears its emergency block", function()
  local s = setup()
  local a, af = window()
  s:focus(a, af)
  s:emergency()
  af.active = false
  local b, bf = window("terminal", "shell", "0x2")
  s:focus(b, bf)
  af.title = "Ponte"
  s:event("window.title", a)
  af.title = "⌨ notebook · Ponte"
  s:focus(a, af)
  equal(s.submap, "ponte-rd")
end)
scenario("existing active control is reconciled on load", function()
  local w, f = window()
  f.active = true
  local s = setup(nil, w)
  equal(s.submap, "ponte-rd")
  equal(#s.calls, 1)
end)
scenario("other submaps are neither captured nor reset", function()
  local s = setup("resize")
  local w, f = window()
  s:focus(w, f)
  equal(s.submap, "resize")
  f.title = "Ponte"
  s:event("window.title", w)
  equal(s.submap, "resize")
  equal(#s.calls, 0)
end)
scenario("old RD submap without active owner is reset on load", function()
  local s = setup("ponte-rd")
  equal(s.submap, "")
end)
scenario("wrapper payload does not impersonate a Window", function()
  local s = setup()
  s:focus({ window = window() })
  equal(s.submap, "")
end)
`;

for (const interpreter of luaInterpreters.length ? luaInterpreters : ['lua']) {
  test(`RD title/focus/close/emergency behavior with ${interpreter}`, { skip: !luaInterpreters.length && 'no Lua interpreter here' }, t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ponte-hypr-lua-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const copy = path.join(dir, 'ponte_rd.lua');
    writeFileSync(copy, module);
    const result = spawnSync(interpreter, ['-', copy], { input: luaHarness, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.match(/^PASS /gm)?.length, 15, 'all behavioral scenarios exercised');
  });
}

test('install validates, is idempotent, and remove gives the config back byte for byte', { skip: !hasHyprland && 'no Hyprland here' }, t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ponte-hypr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  // status calls hyprctl even with HYPR_DIR. Never contact the real session.
  writeFileSync(path.join(bin, 'hyprctl'), '#!/usr/bin/env bash\nexit 97\n', { mode: 0o755 });
  const env = { ...process.env, HYPR_DIR: dir, TMPDIR: dir, PATH: `${bin}:${process.env.PATH}`,
    DISPLAY: '', WAYLAND_DISPLAY: '', HYPRLAND_INSTANCE_SIGNATURE: 'ponte-test-not-live', DBUS_SESSION_BUS_ADDRESS: '' };
  const main = path.join(dir, 'hyprland.lua');
  const original = 'hl.config({ general = { gaps_in = 3 } })\n';
  writeFileSync(main, original);
  const run = (...args) => execFileSync(script, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.match(run('status'), /não instalado/);
  assert.match(run('check'), /passa no --verify-config/);
  assert.equal(readFileSync(main, 'utf8'), original, 'check writes nothing');
  run('install');
  assert.ok(existsSync(path.join(dir, 'ponte_rd.lua')));
  assert.equal(readFileSync(main, 'utf8').split('ponte-rd (tools').length, 2);
  assert.match(run('install'), /já instalado/);
  assert.equal(readFileSync(main, 'utf8').split('ponte-rd (tools').length, 2, 'only one line');
  run('remove');
  assert.equal(readFileSync(main, 'utf8'), original);
  assert.ok(!existsSync(path.join(dir, 'ponte_rd.lua')));
  assert.ok(readdirSync(dir).some(name => name.startsWith('hyprland.lua.bak.')), 'backups kept');
  // A broken config is never touched.
  writeFileSync(main, 'hl.on("window.titulo", function() end)\n');
  const broken = spawnSync(script, ['install'], { env, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(broken.status, 0);
  assert.equal(readFileSync(main, 'utf8'), 'hl.on("window.titulo", function() end)\n');
  assert.ok(!existsSync(path.join(dir, 'ponte_rd.lua')));
});
