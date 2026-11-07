/** A typed content fragment from DeepSeek's streaming protocol. */
export interface DeepSeekFragment {
  type?: string;
  content?: string;
}

/** Where a fragment's text goes: the thinking stream or the reply. */
export type FragmentKind = 'THINK' | 'RESPONSE';

/** Text pulled out of one stream event, split by where it goes. */
export interface Extracted {
  thinking: string;
  content: string;
}

/**
 * Copy of the reply's fragment list as DeepSeek builds it up over the stream.
 *
 * DeepSeek adds fragments, appends text to the last one, and sometimes sends
 * the whole list again in place of the old one (`{"p":"response/fragments","v":[...]}`
 * with no `o`). Keeping the list lets a resent list yield only the text not
 * yet passed on, instead of skipping the reply or repeating the thinking.
 */
export class FragmentTracker {
  private frags: { kind: FragmentKind; text: string }[] = [];

  /** Kind of the last fragment; where untyped text goes. */
  active: FragmentKind = 'RESPONSE';

  /**
   * Fragments added at the end of the list.
   * @param list - The new fragments.
   * @param out - Receives their text.
   */
  Add(list: DeepSeekFragment[], out: Extracted): void {
    for (const frag of list) {
      const kind = KindOf(frag.type, this.active);
      const text = typeof frag.content === 'string' ? frag.content : '';
      this.frags.push({ kind, text });
      this.active = kind;
      Put(out, kind, text);
    }
  }

  /**
   * Text appended to the last fragment.
   * @param text - The appended text.
   * @param out - Receives it.
   * @param kind - Where it goes, when the event says so (an SSE 'thinking' event).
   */
  Append(text: string, out: Extracted, kind: FragmentKind = this.active): void {
    const last = this.frags[this.frags.length - 1];
    if (last && last.kind === kind) last.text += text;
    Put(out, kind, text);
  }

  /**
   * The whole list sent again in place of the old one. Passes on only what
   * is new: text past the end of a fragment already seen, and new fragments.
   * A fragment whose text no longer starts with what was passed on can't be
   * taken back, so it is taken as-is and passes nothing on.
   * @param list - The full fragment list.
   * @param out - Receives the new text.
   * @returns How many fragments changed in a way that couldn't be passed on.
   */
  Replace(list: DeepSeekFragment[], out: Extracted): number {
    let mismatched = 0;
    let kind = this.active;
    const next = list.map((frag, i) => {
      kind = KindOf(frag.type, kind);
      const text = typeof frag.content === 'string' ? frag.content : '';
      const old = this.frags[i];
      if (!old) Put(out, kind, text);
      else if (old.kind === kind && text.startsWith(old.text)) Put(out, kind, text.slice(old.text.length));
      else mismatched++;
      return { kind, text };
    });
    this.frags = next;
    this.active = kind;
    return mismatched;
  }
}

function KindOf(type: string | undefined, fallback: FragmentKind): FragmentKind {
  if (type === 'THINK' || type === 'THINKING') return 'THINK';
  if (type === 'RESPONSE') return 'RESPONSE';
  return fallback;
}

function Put(out: Extracted, kind: FragmentKind, text: string): void {
  if (kind === 'THINK') out.thinking += text;
  else out.content += text;
}
