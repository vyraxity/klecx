"use client";

import * as React from "react";

/**
 * Step 10.5: focus goes back to what opened a dialog, sheet or alert.
 *
 * Radix returns focus only to a `<…Trigger>`; most of Klecx's dialogs are
 * opened from state (a button's onClick, a shortcut), so focus fell to
 * <body> on close and keyboard users had to start again from the top. The
 * content records the element that had focus when it opened (`<OpenerCapture>`
 * as its first child: its layout effect runs before Radix moves focus into the
 * dialog) and `onCloseAutoFocus` focuses it again while it is still on the
 * page. Otherwise (e.g. it was a menu item that's gone) Radix's own behaviour
 * applies.
 */
export function useReturnFocus(handler?: (event: Event) => void) {
  const openerRef = React.useRef<HTMLElement | null>(null);

  const onCloseAutoFocus = React.useCallback(
    (event: Event) => {
      handler?.(event);
      if (event.defaultPrevented) return;
      const el = openerRef.current;
      openerRef.current = null;
      if (el && el.isConnected) {
        event.preventDefault();
        el.focus({ preventScroll: true });
      }
    },
    [handler]
  );

  return { openerRef, onCloseAutoFocus };
}

export function OpenerCapture({ openerRef }: { openerRef: React.MutableRefObject<HTMLElement | null> }) {
  React.useLayoutEffect(() => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [openerRef]);
  return null;
}
