// Kako je nastao komentar (`compose`, core/spec/events.md §2). Samo opsezi: bez teksta, bez
// vremena između tastera, bez putanje miša — to bi bila biometrija.

import { keysBucket, lengthBucket, pastedBucket, type Keys, type Length, type Pasted } from "./measure.js";

export interface ComposeFields {
  focus_ms: number;
  keys: Keys;
  pasted: boolean;
  pasted_chars: Pasted;
  length: Length;
}

export class Compose {
  private focusAt: number | null = null;
  private keys = 0;
  private pastedChars = 0;
  private pasted = false;

  focus(now: number): void {
    if (this.focusAt === null) this.focusAt = now;
  }

  key(): void {
    this.keys++;
  }

  paste(chars: number): void {
    this.pasted = true;
    this.pastedChars += chars;
  }

  /** Pri slanju forme; posle toga brojanje kreće iz početka (sledeći komentar). */
  submit(now: number, length: number): ComposeFields {
    const fields: ComposeFields = {
      focus_ms: this.focusAt === null ? 0 : Math.round(Math.max(0, now - this.focusAt)),
      keys: keysBucket(this.keys),
      pasted: this.pasted,
      pasted_chars: pastedBucket(this.pastedChars),
      length: lengthBucket(length),
    };
    this.focusAt = null;
    this.keys = 0;
    this.pastedChars = 0;
    this.pasted = false;
    return fields;
  }
}
