/** Separate xterm's protocol replies from keystrokes without inspecting a
 * terminal screen. Unknown sequences remain input, never evidence of idleness.
 * Incomplete replies block handoff until their final byte arrives. */
export class NativeInput {
  private pending = '';
  private paste = false;

  incomplete(): boolean { return !!this.pending || this.paste; }

  take(data: string): string {
    const input = this.pending + data;
    this.pending = '';
    let text = '';
    for (let index = 0; index < input.length;) {
      const rest = input.slice(index);
      if (rest.startsWith('\x1b[201~') && this.paste) { this.paste = false; index += 6; continue; }
      if (input[index] !== '\x1b') { text += this.paste && input[index] === '\r' ? '\n' : input[index]; index++; continue; }
      if (rest === '\x1b' || rest === '\x1b[') { this.pending = rest; break; }
      if (rest.startsWith('\x1b[')) {
        const body = /^[0-?]*[ -/]*[@-~]/.exec(rest.slice(2))?.[0];
        const sequence = body === undefined ? undefined : `\x1b[${body}`;
        if (!sequence && rest.length < 128) { this.pending = rest; break; }
        if (sequence) {
          index += sequence.length;
          if (sequence === '\x1b[200~' && !this.paste) { this.paste = true; continue; }
          // Focus, device attributes, window reports and terminal mode
          // reports. Arrow/function keys and bracketed paste text are retained.
          if (!this.paste && /^(?:[IO]|[?>]?[\d;]+c|[\d;]+t|\?[\d;]+\$y)$/.test(sequence.slice(2))) continue;
          text += sequence;
          continue;
        }
      }
      text += input[index];
      index++;
    }
    return text;
  }
}
