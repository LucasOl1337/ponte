"""Read-only capability probe and argv-only mission execution on the chosen host."""
import base64
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tomllib

HOME = pathlib.Path.home()

def load(file, toml=False):
    try:
        with open(HOME / file, 'rb') as handle:
            return tomllib.load(handle) if toml else json.load(handle)
    except (OSError, ValueError):
        return {}

def catalog():
    harnesses = []
    def add(name, models):
        if shutil.which(name) and models:
            harnesses.append(dict(id=name, models=models))
    cfg = load('.jcode/config.toml', True)
    models = []
    for provider, profile in cfg.get('providers', {}).items():
        if 'groq' in provider.lower():
            continue
        for model in profile.get('models', []):
            if isinstance(model.get('id'), str):
                models.append(dict(id=model['id'], provider=provider))
    add('jcode', models)
    claude = load('.claude/settings.json')
    cm = claude.get('model') or claude.get('env', {}).get('ANTHROPIC_MODEL')
    add('claude', [dict(id=cm, provider='configured')] if isinstance(cm, str) else [])
    codex = load('.codex/config.toml', True)
    add('codex', [dict(id=codex['model'], provider=codex.get('model_provider', 'openai'))] if isinstance(codex.get('model'), str) else [])
    pi = load('.pi/agent/models.json')
    add('pi', [dict(id=m['id'], provider=p) for p, v in pi.get('providers', {}).items() if 'groq' not in p.lower() for m in v.get('models', []) if isinstance(m.get('id'), str)])
    projects = HOME / 'Projects'
    directories = [str(HOME)]
    if projects.is_dir():
        directories += [str(p) for p in sorted(projects.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True) if p.is_dir()][:20]
    return dict(hostname=socket.gethostname(), home=str(HOME), harnesses=harnesses, directories=directories)

def validate(value):
    current = catalog()
    harness = next((h for h in current['harnesses'] if h['id'] == value.get('harness')), None)
    if not harness or not any(m['id'] == value.get('model') and m['provider'] == value.get('provider') for m in harness['models']):
        raise ValueError('MISSION_OPTION_UNAVAILABLE')
    directory = value.get('directory', '')
    if not isinstance(directory, str) or len(directory) > 1024 or any(ord(c) < 32 for c in directory):
        raise ValueError('PROJECT_NOT_ALLOWED')
    directory = pathlib.Path(directory.replace('~/', str(HOME) + '/', 1) if directory.startswith('~/') else str(HOME) if directory == '~' else directory)
    if not directory.is_absolute() or not directory.is_dir():
        raise ValueError('PROJECT_NOT_ALLOWED')
    return str(directory.resolve())

def argv(v):
    h, model, provider, prompt, resume = (v.get(k) for k in ('harness', 'model', 'provider', 'prompt', 'resume'))
    if h == 'jcode':
        if resume:
            session = load('.jcode/sessions/' + resume + '.json')
            if session.get('model') != model or session.get('provider_key') != provider:
                raise ValueError('MISSION_MODEL_CHANGED')
        return ['jcode', '--no-update', '--no-selfdev', '--provider-profile', provider, '-m', model, *(['--resume', resume] if resume else []), 'run', '--ndjson', '--', prompt]
    if h == 'claude':
        return ['claude', '--model', model, '--print', '--verbose', '--output-format', 'stream-json', *(['--resume', resume] if resume else []), '--', prompt]
    if h == 'codex':
        return ['codex', 'exec', *(['resume', resume] if resume else []), '--json', '-m', model, '--', prompt]
    if h == 'pi':
        return ['pi', '--provider', provider, '--model', model, '--mode', 'json', '--print', *(['--session', resume] if resume else []), '--', prompt]
    raise ValueError('MISSION_OPTION_UNAVAILABLE')

def main():
    v = json.loads(base64.b64decode(sys.argv[1]))
    if v['action'] == 'catalog':
        print(json.dumps(catalog()))
        return
    directory = validate(v)
    if v['action'] == 'validate':
        print(json.dumps(dict(directory=directory)))
        return
    env = dict(os.environ)
    for key in list(env):
        if key.startswith(('MAESTRI_', 'JCODE_SESSION', 'JCODE_PARENT', 'JCODE_SWARM', 'JCODE_PROVIDER_PROFILE', 'TMUX')):
            env.pop(key, None)
    env['JCODE_CHECK_UPDATES'] = '0'
    # A model call happens only here, after destination validation. No shell, retries or fallback.
    process = subprocess.Popen(argv(v), cwd=directory, env=env)
    sys.exit(process.wait())

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(dict(type='ponte_error', error=str(error))), flush=True)
        sys.exit(3)
