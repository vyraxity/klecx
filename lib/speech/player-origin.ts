"use client";

/**
 * Step 9.4: which "Read aloud" button started the current reading. The
 * floating player uses it to move keyboard focus back when reading stops and
 * to scroll back to the text being read. Not React state: a DOM reference.
 */
let origin: HTMLElement | null = null;
let focusPlayerOnOpen = false;

export function setReadAloudOrigin(el: HTMLElement | null, moveFocus: boolean) {
  origin = el;
  focusPlayerOnOpen = moveFocus;
}

/** The button, while it is still on the page. */
export function getReadAloudOrigin(): HTMLElement | null {
  return origin?.isConnected ? origin : null;
}

/** True once after Read aloud was pressed: the player takes focus when it opens. */
export function takeFocusRequest(): boolean {
  const v = focusPlayerOnOpen;
  focusPlayerOnOpen = false;
  return v;
}
