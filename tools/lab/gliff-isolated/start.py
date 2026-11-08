#!/usr/bin/env python3
"""Launch isolated Cage -> Hyprland -> observable fixture, bounded readiness."""
import os, sys, subprocess, time, json, signal, fcntl
from pathlib import Path
root=Path(__file__).resolve().parent
runtime=Path(f'/run/user/{os.getuid()}/pg-proof')
runtime.mkdir(mode=0o700, exist_ok=True)
if sys.argv[1:] != ['inside']:
    lease=open(runtime/'owner.lock','w')
    fcntl.flock(lease,fcntl.LOCK_EX | fcntl.LOCK_NB)
    (root/'supervisor.pid').write_text(str(os.getpid()))
    subprocess.run(['cc','-shared','-fPIC',str(root/'cage-xdg-v6.c'),'-ldl','-o',str(root/'cage-xdg-v6.so')],check=True)
    args=['bwrap','--die-with-parent','--new-session','--unshare-pid','--unshare-ipc','--ro-bind','/','/','--proc','/proc','--dev','/dev','--tmpfs','/run','--tmpfs','/tmp','--bind',str(root),str(root),'--bind',str(runtime),str(runtime)]
    for node in Path('/dev/dri').glob('renderD*'):
        args += ['--dev-bind',str(node),str(node)]
    args += ['--clearenv','--setenv','HOME',str(root/'home'),'--setenv','PATH','/usr/bin:/bin','--setenv','LANG','C.UTF-8','--setenv','XDG_RUNTIME_DIR',str(runtime),'--setenv','XDG_CONFIG_HOME',str(root/'home/config'),'--setenv','HYPRLAND_NO_SD_VARS','1','--setenv','HYPRLAND_NO_SD_NOTIFY','1','--setenv','GLIFF_PROOF_ROOT',str(root),'--setenv','LIBSEAT_BACKEND','seatd','--setenv','SEATD_SOCK',str(runtime/'nonexistent-seatd'),'--','dbus-run-session','--','python3',str(root/'start.py'),'inside']
    (root/'home/config').mkdir(parents=True,exist_ok=True)
    sys.exit(subprocess.call(args))
children=[]
def start(name,args,env=None):
    p=subprocess.Popen(args,env=env,stdout=open(root/f'{name}.log','w'),stderr=subprocess.STDOUT)
    children.append(p); return p

def until(check,p,seconds=20):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if p.poll() is not None: raise RuntimeError(f'process {p.pid} exited {p.returncode}')
        v=check()
        if v:return v
        time.sleep(.1)
    raise TimeoutError('readiness deadline')

def stop(*args):
    raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
try:
    previous_instances=set((runtime/'hypr').glob('*'))
    env=dict(os.environ,WLR_BACKENDS='headless',WLR_RENDERER='gles2',WLR_RENDER_DRM_DEVICE=('/dev/dri/renderD129' if Path('/dev/dri/renderD129').exists() else '/dev/dri/renderD128'),WLR_HEADLESS_OUTPUTS='1',LD_PRELOAD=str(root/'cage-xdg-v6.so'))
    hypr=start('hyprland',['cage','--','env','-u','LD_PRELOAD','Hyprland','--config',str(root/'hyprland.lua')],env)
    def find_instance():
        for lock in (runtime/'hypr').glob('*/hyprland.lock'):
            if lock.parent in previous_instances: continue
            lines=lock.read_text().splitlines()
            if len(lines)>1 and (lock.parent/'.socket.sock').exists(): return (lock.parent.name,lines[1])
    sig,wayland=until(find_instance,hypr)
    env=dict(os.environ,WAYLAND_DISPLAY=wayland,HYPRLAND_INSTANCE_SIGNATURE=sig,GDK_BACKEND='wayland')
    subprocess.run(['hyprctl','output','create','headless','PROOF'],env=env,check=True)
    state={'runtime':str(runtime),'instance':sig,'wayland':wayland,'sandbox_pid':os.getpid()}
    (root/'state.json').write_text(json.dumps(state,indent=2))
    fixture=start('fixture',['python3',str(root/'fixture.py')],env)
    print(json.dumps({'ready':True,**state}),flush=True)
    if fixture.wait() != 0:
        raise RuntimeError('fixture exited unsuccessfully; inspect fixture.log')
finally:
    for p in reversed(children):
        if p.poll() is None:p.terminate()
    for p in children:
        try:p.wait(timeout=5)
        except subprocess.TimeoutExpired:p.kill()
