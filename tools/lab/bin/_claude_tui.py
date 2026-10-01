"""Lab stand-in for the Claude Code TUI. Never calls a model.

It draws like Claude Code: the conversation scrolls in the normal screen and
only the footer (input box, mode line or a permission menu) is erased and
redrawn in place. The terminal cursor is hidden; the caret is an inverse cell.
It asks for bracketed paste, so a paste arrives between ESC[200~ and ESC[201~.

- Enter sends the request; the fake answers and asks permission to run
  `npm test` with a 1/2/3 menu (keys 1, 2, 3, arrows + Enter, Esc = 3).
- Shift+Tab cycles default -> accept edits -> plan mode.
- Ctrl+C clears the input (twice on an empty input exits), Ctrl+D exits,
  Ctrl+U clears, Ctrl+L redraws, Ctrl+O toggles the detail line.
- Ctrl+J (a line feed byte) inserts a new line without sending, as Claude
  Code's "ctrl+j": "chat:newline" binding does.
- Every key it recognises is logged to events.jsonl as
  {"tool": "claude-tui", "key": NAME}, and requests, pastes and menu answers
  too, so a test can prove what reached the program.
"""
import json, os, re, select, signal, sys, termios, time, tty
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lab import locked, EVENTS

ORANGE = '\x1b[38;2;215;119;87m'
GREY = '\x1b[38;5;244m'
BLUE = '\x1b[38;5;75m'
GREEN = '\x1b[38;5;114m'
RED = '\x1b[38;5;203m'
BOLD, DIM, INVERSE, RESET = '\x1b[1m', '\x1b[2m', '\x1b[7m', '\x1b[0m'
MODES = [('default', GREY + '? for shortcuts' + RESET),
         ('accept', '\x1b[38;5;177m⏵⏵ accept edits on' + GREY + ' (shift+tab to cycle)' + RESET),
         ('plan', '\x1b[38;5;73m⏸ plan mode on' + GREY + ' (shift+tab to cycle)' + RESET)]
CHOICES = ['Yes', "Yes, and don't ask again for this command", 'No, and tell Claude what to do differently (esc)']

# Longest first: tmux sends Home/End as ESC[1~/ESC[4~, other terminals ESC[H/ESC[F or ESC O H/F.
SEQUENCES = sorted({
    '\x1b[200~': 'PasteStart', '\x1b[Z': 'ShiftTab', '\x1b[A': 'ArrowUp', '\x1b[B': 'ArrowDown',
    '\x1b[C': 'ArrowRight', '\x1b[D': 'ArrowLeft', '\x1bOA': 'ArrowUp', '\x1bOB': 'ArrowDown',
    '\x1bOC': 'ArrowRight', '\x1bOD': 'ArrowLeft', '\x1b[5~': 'PageUp', '\x1b[6~': 'PageDown',
    '\x1b[1~': 'Home', '\x1b[7~': 'Home', '\x1b[H': 'Home', '\x1bOH': 'Home',
    '\x1b[4~': 'End', '\x1b[8~': 'End', '\x1b[F': 'End', '\x1bOF': 'End', '\x1b[3~': 'Delete',
}.items(), key=lambda item: -len(item[0]))
CONTROLS = {'\r': 'Enter', '\t': 'Tab', '\x7f': 'BackSpace', '\x08': 'BackSpace', '\x1b': 'Escape'}
for letter in 'abcdefghijklmnopqrstuvwxyz':
    CONTROLS.setdefault(chr(ord(letter) - 96), 'Ctrl+' + letter.upper())
CONTROLS['\x03'] = 'Interrupt'


def log(**event):
    with locked():
        with open(EVENTS, 'a') as f: f.write(json.dumps({'t': time.time(), 'tool': 'claude-tui', **event}, ensure_ascii=False) + '\n')


class Tui:
    def __init__(self, request):
        self.out = sys.stdout
        self.mode = 0
        self.text, self.caret = '', 0
        self.menu, self.choice = None, 0
        self.footer_height = 0
        self.transcript = []
        self.detail = False
        self.interrupts = 0
        self.pasted = 0
        self.say(ORANGE + '╭' + '─' * (self.width() - 2) + '╮' + RESET)
        self.say(self.boxed(ORANGE, BOLD + ' ✻ Welcome to Claude Code' + RESET + GREY + ' (lab, no model)' + RESET))
        self.say(self.boxed(ORANGE, GREY + '   cwd: ' + os.getcwd() + RESET))
        self.say(ORANGE + '╰' + '─' * (self.width() - 2) + '╯' + RESET)
        if request: self.submit(request)
        self.draw()

    def width(self):
        try: return max(20, os.get_terminal_size(1).columns)
        except OSError: return 80

    def boxed(self, colour, content):
        # A box row with both sides, like Claude Code: the right side sits in the last column.
        room = self.width() - 2 - len(re.sub(r'\x1b\[[0-9;:]*m', '', content))
        return colour + '│' + RESET + content + RESET + (' ' * room + colour + '│' + RESET if room >= 0 else '')

    def fit(self, line):
        # Wrap by characters without counting SGR codes, so the footer height stays exact.
        visible = re.sub(r'\x1b\[[0-9;:]*m', '', line)
        if len(visible) <= self.width(): return [line]
        plain, width = visible, self.width() - 1
        return [plain[i:i + width] for i in range(0, len(plain), width)] or ['']

    def say(self, line):
        for part in self.fit(line):
            self.transcript.append(part)
        self.transcript = self.transcript[-2000:]
        self.erase()
        for part in self.fit(line): self.out.write(part + RESET + '\r\n')
        self.out.flush()

    def erase(self):
        if self.footer_height:
            self.out.write('\r' + (f'\x1b[{self.footer_height - 1}A' if self.footer_height > 1 else '') + '\x1b[J')
            self.footer_height = 0

    def footer(self):
        width = self.width()
        if self.menu:
            lines = [ORANGE + '╭' + '─' * (width - 2) + '╮' + RESET,
                     BOLD + ' Bash command' + RESET,
                     '   ' + self.menu,
                     ' Do you want to proceed?']
            for index, label in enumerate(CHOICES):
                pointer = BLUE + '❯ ' if index == self.choice else '  '
                lines.append(' ' + pointer + f'{index + 1}. {label}'[:width - 5] + RESET)
            lines.append(ORANGE + '╰' + '─' * (width - 2) + '╯' + RESET)
            return lines
        rows = self.text.split('\n') or ['']
        lines = [GREY + '╭' + '─' * (width - 2) + '╮' + RESET]
        offset = 0
        for number, row in enumerate(rows):
            prefix = '> ' if number == 0 else '  '
            start, end = offset, offset + len(row)
            if start <= self.caret <= end:
                at = self.caret - start
                cell = row[at] if at < len(row) else ' '
                shown = row[:at] + INVERSE + cell + RESET + row[at + 1:]
            else: shown = row
            lines.append(self.boxed(GREY, ' ' + prefix + shown))
            offset = end + 1
        lines.append(GREY + '╰' + '─' * (width - 2) + '╯' + RESET)
        lines.append('  ' + MODES[self.mode][1] + (GREY + '  · detail on' + RESET if self.detail else ''))
        return lines

    def draw(self):
        self.erase()
        lines = self.footer()
        self.out.write('\r\n'.join(line + RESET for line in lines))
        self.footer_height = len(lines)
        self.out.flush()

    def redraw_all(self):
        rows = os.get_terminal_size(1).lines if sys.stdout.isatty() else 24
        self.out.write('\x1b[H\x1b[2J')
        self.footer_height = 0
        keep = max(0, rows - len(self.footer()) - 1)
        for part in self.transcript[-keep:] if keep else []: self.out.write(part + RESET + '\r\n')
        self.draw()

    def submit(self, request):
        log(event='request', text=request, mode=MODES[self.mode][0], lines=request.count('\n') + 1)
        for number, row in enumerate(request.split('\n')):
            self.say(GREY + ('> ' if number == 0 else '  ') + row + RESET)
        if self.pasted:
            self.say(GREY + f'  [lab] bracketed paste recebido: {self.pasted} colagem(ns), {request.count(chr(10)) + 1} linha(s)' + RESET)
            self.pasted = 0
        if MODES[self.mode][0] == 'plan':
            self.say(ORANGE + '⏺ ' + RESET + 'Plano (lab): 1. ler o código 2. rodar os testes 3. corrigir.')
            return
        self.say(ORANGE + '⏺ ' + RESET + 'Vou rodar os testes do projeto.')
        if MODES[self.mode][0] == 'accept':
            self.answer(0)
        else:
            self.menu, self.choice = 'npm test', 0

    def answer(self, index):
        command = self.menu or 'npm test'
        self.menu = None
        log(event='permission', choice=index + 1, label=CHOICES[index])
        if index < 2:
            self.say(GREEN + '⏺ ' + RESET + BOLD + f'Bash({command})' + RESET)
            self.say(GREY + '  ⎿  ' + RESET + GREEN + '12 passed' + RESET + GREY + ' (lab, nada rodou de verdade)' + RESET)
        else:
            self.say(RED + '⏺ ' + RESET + BOLD + f'Bash({command})' + RESET)
            self.say(GREY + '  ⎿  ' + RESET + RED + 'recusado pelo usuário' + RESET)

    def key(self, name):
        log(key=name)
        if name != 'Interrupt': self.interrupts = 0
        if self.menu:
            if name in ('1', '2', '3'): self.answer(int(name) - 1)
            elif name == 'ArrowUp': self.choice = (self.choice - 1) % 3
            elif name == 'ArrowDown': self.choice = (self.choice + 1) % 3
            elif name == 'Enter': self.answer(self.choice)
            elif name == 'Escape': self.answer(2)
            elif name == 'Interrupt': self.answer(2)
            self.draw(); return True
        if name == 'Enter':
            request, self.text, self.caret = self.text, '', 0
            if request.strip() in ('/exit', 'exit'): return False
            if request.strip(): self.submit(request)
        elif name == 'ShiftTab': self.mode = (self.mode + 1) % len(MODES)
        elif name == 'Ctrl+J': self.insert('\n')
        elif name == 'BackSpace':
            if self.caret: self.text, self.caret = self.text[:self.caret - 1] + self.text[self.caret:], self.caret - 1
        elif name == 'Delete': self.text = self.text[:self.caret] + self.text[self.caret + 1:]
        elif name == 'ArrowLeft': self.caret = max(0, self.caret - 1)
        elif name == 'ArrowRight': self.caret = min(len(self.text), self.caret + 1)
        elif name in ('Home', 'Ctrl+A'): self.caret = self.text.rfind('\n', 0, self.caret) + 1
        elif name in ('End', 'Ctrl+E'):
            end = self.text.find('\n', self.caret); self.caret = len(self.text) if end < 0 else end
        elif name in ('Escape', 'Ctrl+U'): self.text, self.caret = '', 0
        elif name == 'Ctrl+L': self.redraw_all(); return True
        elif name == 'Ctrl+O': self.detail = not self.detail
        elif name == 'Ctrl+D':
            if not self.text: return False
        elif name == 'Interrupt':
            if not self.text:
                self.interrupts += 1
                if self.interrupts >= 2: return False
                self.say(GREY + '  Press Ctrl-C again to exit' + RESET)
            self.text, self.caret = '', 0
        elif name in ('PageUp', 'PageDown', 'Ctrl+R', 'Ctrl+T', 'Ctrl+W', 'Ctrl+Z'):
            self.say(GREY + f'  [lab] tecla {name}' + RESET)
        self.draw()
        return True

    def insert(self, text):
        self.text = self.text[:self.caret] + text + self.text[self.caret:]
        self.caret += len(text)


def main():
    request = ' '.join(sys.argv[1:])
    log(event='start', argv=sys.argv[1:], cwd=os.getcwd())
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    sys.stdout.write('\x1b[?2004h\x1b[?25l')
    tui = Tui(request)
    signal.signal(signal.SIGWINCH, lambda *_: tui.redraw_all())
    pending, pasting, paste = '', False, ''
    decoder = __import__('codecs').getincrementaldecoder('utf-8')('replace')
    try:
        running = True
        while running:
            try: ready, _, _ = select.select([fd], [], [], 0.05 if pending else None)
            except InterruptedError: continue
            if ready:
                chunk = os.read(fd, 4096)
                if not chunk: break
                pending += decoder.decode(chunk)
            elif pending == '\x1b':
                # A lone ESC with nothing after it is the Escape key.
                pending = ''
                running = tui.key('Escape'); continue
            while pending and running:
                if pasting:
                    end = pending.find('\x1b[201~')
                    if end < 0:
                        keep = len(pending) - 5
                        if keep > 0: paste += pending[:keep]; pending = pending[keep:]
                        break
                    paste += pending[:end]; pending = pending[end + 6:]; pasting = False
                    text = paste.replace('\r\n', '\n').replace('\r', '\n')
                    log(event='paste', chars=len(text), lines=text.count('\n') + 1)
                    tui.pasted += 1; tui.insert(text); tui.draw(); paste = ''
                    continue
                if pending.startswith('\x1b'):
                    match = next((item for item in SEQUENCES if pending.startswith(item[0])), None)
                    if match:
                        pending = pending[len(match[0]):]
                        if match[1] == 'PasteStart': pasting = True
                        else: running = tui.key(match[1])
                        continue
                    if len(pending) < 6 and re.fullmatch(r'\x1b(\[[0-9;]*|O)?', pending): break
                    unknown = re.match(r'\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)?', pending).group(0)
                    log(key='unknown', raw=unknown.encode('unicode_escape').decode())
                    pending = pending[len(unknown):]
                    continue
                char, pending = pending[0], pending[1:]
                if char in CONTROLS: running = tui.key(CONTROLS[char])
                elif char.isprintable():
                    if tui.menu: running = tui.key(char)
                    else: log(key='text', text=char); tui.insert(char); tui.draw()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        sys.stdout.write('\r\n\x1b[?2004l\x1b[?25h' + RESET)
        sys.stdout.flush()
        log(event='exit')


if __name__ == '__main__':
    main()
