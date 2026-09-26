"""Ponte Desktop entry point. Offline commands do not import Qt or initialize ADB."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
EXIT_CODES = {'success': 0, 'usage': 2, 'dependency': 3, 'timeout': 4, 'device': 5, 'command': 6, 'interrupted': 130}
COMMANDS = [
    {'name': 'gui', 'description': 'Abrir o aplicativo nativo, sem conectar automaticamente.', 'arguments': ['--demo', '--serial SERIAL']},
    {'name': 'schema', 'description': 'Descobrir comandos e formatos sem ADB ou Qt.', 'arguments': []},
    {'name': 'version', 'description': 'Mostrar versão local.', 'arguments': []},
    {'name': 'status', 'description': 'Consultar dependências, preferências e dispositivos ADB.', 'arguments': []},
    {'name': 'devices', 'description': 'Listar dispositivos, sem selecionar o primeiro.', 'arguments': []},
    {'name': 'connect', 'description': 'Conectar endereço explícito e salvar após verificar o alvo.', 'arguments': ['ADDRESS']},
    {'name': 'pair', 'description': 'Parear com código somente via stdin.', 'arguments': ['ADDRESS', '--stdin']},
    {'name': 'select', 'description': 'Selecionar serial autorizado já listado pelo ADB.', 'arguments': ['SERIAL']},
    {'name': 'disconnect', 'description': 'Desconectar só o endereço de rede informado.', 'arguments': ['SERIAL']},
    {'name': 'mirror', 'description': 'Abrir scrcpy, gerenciado até fechar a janela.', 'arguments': ['--serial SERIAL', '--profile light|balanced|sharp', '--audio', '--clipboard', '--read-only', '--dry-run']},
    {'name': 'key', 'description': 'Enviar uma tecla permitida ao alvo explícito.', 'arguments': ['--serial SERIAL', '--key BACK|HOME|APP_SWITCH|POWER|VOLUME_UP|VOLUME_DOWN|MUTE|WAKEUP']},
    {'name': 'tap', 'description': 'Tocar um pixel do celular.', 'arguments': ['--serial SERIAL', '--x INT', '--y INT']},
    {'name': 'swipe', 'description': 'Arrastar entre pixels do celular.', 'arguments': ['--serial SERIAL', '--x1 INT', '--y1 INT', '--x2 INT', '--y2 INT', '--duration MS']},
    {'name': 'text', 'description': 'Enviar texto ASCII de uma linha via stdin; para Unicode use a janela scrcpy.', 'arguments': ['--serial SERIAL', '--stdin']},
    {'name': 'screenshot', 'description': 'Salvar PNG privado sem sobrescrever arquivo.', 'arguments': ['--serial SERIAL', '--output PATH']},
    {'name': 'preferences', 'description': 'Salvar qualidade e opções explícitas do desktop.', 'arguments': ['--profile light|balanced|sharp', '--audio', '--clipboard', '--read-only']},
    {'name': 'install', 'description': 'Instalar launcher só para este usuário, sem autostart.', 'arguments': []},
    {'name': 'uninstall', 'description': 'Remover somente o launcher gerenciado pelo Ponte.', 'arguments': []},
]


class UsageError(Exception):
    code = 'USAGE'


class Parser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        kwargs['allow_abbrev'] = False
        super().__init__(*args, **kwargs)

    def error(self, message):
        # argparse errors may echo the value supplied by the caller. Don't
        # reproduce unknown argv, pairing codes or stdin content in diagnostics.
        raise UsageError('Argumentos inválidos. Consulte ./ponte desktop help ou schema.')


def parser():
    result = Parser(prog='ponte desktop', description='Veja e controle seu Android pelo computador. Sem subcomando, abre o app.', epilog='Resultados CLI são JSON. Ajuda/schema não precisam de Qt. Guia: docs/desktop.md.')
    result.add_argument('--demo', action='store_true', help='Abrir demonstração sintética, sem ADB.')
    result.add_argument('--serial', help='Sugerir um serial na GUI, sem selecioná-lo automaticamente.')
    sub = result.add_subparsers(dest='command')
    for name in ['help', 'schema', 'version', 'status', 'devices', 'install', 'uninstall']:
        sub.add_parser(name)
    gui = sub.add_parser('gui')
    gui.add_argument('--demo', action='store_true', default=argparse.SUPPRESS)
    gui.add_argument('--serial', default=argparse.SUPPRESS)
    for name in ['connect', 'pair']:
        item = sub.add_parser(name)
        item.add_argument('address')
        if name == 'pair':
            item.add_argument('--stdin', action='store_true', required=True)
    for name in ['select', 'disconnect']:
        sub.add_parser(name).add_argument('serial')
    for name in ['mirror', 'key', 'tap', 'swipe', 'text', 'screenshot']:
        item = sub.add_parser(name)
        item.add_argument('--serial', required=True)
        if name == 'key':
            item.add_argument('--key', required=True, choices=['BACK', 'HOME', 'APP_SWITCH', 'POWER', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE', 'WAKEUP'])
        if name == 'tap':
            for coordinate in ['x', 'y']:
                item.add_argument('--' + coordinate, required=True, type=int)
        if name == 'swipe':
            for coordinate in ['x1', 'y1', 'x2', 'y2']:
                item.add_argument('--' + coordinate, required=True, type=int)
            item.add_argument('--duration', default=300, type=int)
        if name == 'text':
            item.add_argument('--stdin', action='store_true', required=True)
        if name == 'screenshot':
            item.add_argument('--output', required=True)
        if name == 'mirror':
            profile_arguments(item)
            item.add_argument('--dry-run', action='store_true')
    profile_arguments(sub.add_parser('preferences'))
    return result


def profile_arguments(item):
    item.add_argument('--profile', choices=['light', 'balanced', 'sharp'], default='balanced')
    item.add_argument('--audio', action='store_true')
    item.add_argument('--clipboard', action='store_true')
    item.add_argument('--read-only', action='store_true')


def read_stdin(limit):
    if sys.stdin.isatty():
        raise UsageError('Envie a entrada por pipe. O CLI não abre prompts.')
    # A closed pipe/file is required. Never wait indefinitely for an abandoned
    # pairing process or consume unbounded input from another agent.
    try:
        import select
        chunks = []
        size = 0
        deadline = time.monotonic() + 15
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([sys.stdin], [], [], remaining)[0]:
                raise TimeoutError('stdin não foi fechado em 15 segundos.')
            chunk = os.read(sys.stdin.fileno(), min(4096, limit + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise UsageError('Entrada excedeu o limite permitido.')
            chunks.append(chunk)
        return b''.join(chunks).decode('utf-8', 'strict').removesuffix('\n').removesuffix('\r')
    except UnicodeError:
        raise UsageError('A entrada precisa ser UTF-8.') from None


def emit(data=None, error=None, pretty=False):
    value = {'schemaVersion': 1, 'ok': error is None}
    value['error' if error else 'data'] = error if error else data
    print(json.dumps(value, ensure_ascii=False, indent=2 if pretty else None))


def run_mirror(command):
    """Keep stdout JSON-only and terminate only our child on interruption."""
    child = None
    old_handlers = {}
    def interrupt(_signum, _frame):
        raise KeyboardInterrupt
    try:
        for sig in [signal.SIGINT, signal.SIGTERM]:
            old_handlers[sig] = signal.signal(sig, interrupt)
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=sys.stderr, stderr=sys.stderr, start_new_session=True)
        code = child.wait()
        if code:
            raise RuntimeError('A janela do scrcpy encerrou com erro. Confira conexão e autorização do celular.')
        return {'closed': True, 'exitCode': code}
    finally:
        try:
            if child and child.poll() is None:
                try:
                    child.terminate()
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=3)
                except ProcessLookupError:
                    pass
        finally:
            for sig, handler in old_handlers.items():
                signal.signal(sig, handler)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    pretty = '--pretty' in argv
    json_help = '--json' in argv
    if argv.count('--pretty') > 1 or argv.count('--json') > 1:
        emit(error={'code': 'USAGE', 'message': 'Opção global repetida.'}, pretty=pretty)
        return 2
    argv = [arg for arg in argv if arg not in ['--pretty', '--json']]
    if argv in [['--schema'], ['help', '--schema']] or (argv == ['help'] and json_help):
        argv = ['schema']
    elif argv == ['--version']:
        argv = ['version']
    try:
        option_names = [arg.split('=', 1)[0] for arg in argv if arg.startswith('--')]
        if len(set(option_names)) != len(option_names):
            raise UsageError('Opção repetida. Informe cada opção uma vez.')
        args = parser().parse_args(argv)
        command = args.command or 'gui'
        if command not in ['gui', 'help'] and args.demo:
            raise UsageError('--demo só vale para a interface gráfica.')
        if command == 'help':
            parser().print_help()
            print('\n' + '\n'.join(f"  {item['name']:<14} {item['description']}" for item in COMMANDS))
            return 0
        if command == 'schema':
            from .bridge import schema as bridge_schema
            emit({'commands': COMMANDS, 'exitCodes': EXIT_CODES, 'globalOptions': ['--json', '--pretty'], 'targetPolicy': 'Every effect requires an explicitly selected authorized serial. No fallback device.', 'bridge': bridge_schema()}, pretty=pretty)
            return 0
        if command == 'version':
            version = json.loads((ROOT / 'package.json').read_text())['version']
            emit({'name': 'Ponte Desktop', 'version': version, 'cliSchemaVersion': 1}, pretty=pretty)
            return 0
        if command == 'gui':
            try:
                from .gui import main as gui_main
            except ImportError:
                emit(error={'code': 'DEPENDENCY_MISSING', 'message': 'A interface precisa de PySide6. No Arch: sudo pacman -S pyside6. Os comandos CLI continuam disponíveis.'}, pretty=pretty)
                return 3
            if not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY') or os.environ.get('QT_QPA_PLATFORM') in ['offscreen', 'minimal']):
                emit(error={'code': 'DISPLAY_UNAVAILABLE', 'message': 'Abra o aplicativo numa sessão gráfica. Por SSH, use os comandos desktop help/schema/status.'}, pretty=pretty)
                return 3
            gui_args = (['--demo'] if args.demo else []) + (['--serial', args.serial] if args.serial else [])
            return gui_main(gui_args)
        if command in ['install', 'uninstall']:
            from .install import install, uninstall
            emit((install if command == 'install' else uninstall)(), pretty=pretty)
            return 0
        from .bridge import DesktopBridge
        bridge = DesktopBridge()
        if command == 'status':
            data = bridge.status()
        elif command == 'devices':
            data = {'devices': bridge.devices()}
        elif command == 'connect':
            data = bridge.connect(args.address)
        elif command == 'pair':
            bridge.pair(args.address, read_stdin(32))
            data = {'paired': True, 'address': args.address}
        elif command == 'select':
            data = bridge.select(args.serial)
        elif command == 'disconnect':
            bridge.disconnect(args.serial)
            data = {'disconnected': True, 'serial': args.serial}
        elif command == 'preferences':
            data = bridge.save_preferences(args.profile, args.audio, args.clipboard, args.read_only)
        elif command == 'mirror':
            process = bridge.mirror_command(args.serial, args.profile, args.audio, args.clipboard, args.read_only)
            data = {'command': process, 'dryRun': True} if args.dry_run else run_mirror(process)
        elif command == 'screenshot':
            output = bridge.screenshot(args.serial, str(Path(args.output).absolute()))
            data = {'output': output, 'serial': args.serial}
        else:
            fields = {'key': ['key'], 'tap': ['x', 'y'], 'swipe': ['x1', 'y1', 'x2', 'y2', 'duration'], 'text': []}[command]
            values = {name: getattr(args, name) for name in fields}
            if command == 'text':
                values['text'] = read_stdin(4096)
            bridge.action(args.serial, command, values)
            data = {'sent': True, 'serial': args.serial, 'action': command}
        emit(data, pretty=pretty)
        return 0
    except KeyboardInterrupt:
        emit(error={'code': 'INTERRUPTED', 'message': 'Operação interrompida. Confira o estado do aparelho antes de repetir.'}, pretty=pretty)
        return 130
    except Exception as error:
        code = getattr(error, 'code', 'USAGE' if isinstance(error, (ValueError, UsageError)) else 'TIMEOUT' if isinstance(error, (TimeoutError, subprocess.TimeoutExpired)) else 'COMMAND_FAILED').upper()
        if code in ['DEPENDENCY_MISSING', 'ADB_MISSING', 'SCRCPY_MISSING']:
            exit_code = 3
        elif 'TIMEOUT' in code:
            exit_code = 4
        elif any(word in code for word in ['UNAUTHORIZED', 'OFFLINE', 'NOT_CONNECTED', 'NOT_FOUND', 'NOT_READY']):
            exit_code = 5
        elif code in ['COMMAND_FAILED', 'COMMAND_ERROR', 'ADB_FAILED', 'SCRCPY_FAILED', 'CONNECT_FAILED', 'DISCONNECT_FAILED', 'PAIR_FAILED', 'INVALID_OUTPUT', 'OUTPUT_TOO_LARGE', 'INVALID_PNG', 'PERSISTENCE_FAILED', 'SCREENSHOT_FAILED']:
            exit_code = 6
        else:
            exit_code = 2
        message = str(error) if getattr(error, 'code', None) or isinstance(error, (UsageError, ValueError, TimeoutError, RuntimeError)) else 'Não foi possível completar a operação. Confira configuração, dependências e conexão.'
        emit(error={'code': code, 'message': message}, pretty=pretty)
        return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
