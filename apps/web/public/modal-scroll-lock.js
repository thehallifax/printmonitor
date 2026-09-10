export function createPageScrollLock(documentRef = document, windowRef = window) {
  let state = null;

  function lock() {
    if (state) return;
    const root = documentRef.documentElement;
    const body = documentRef.body;
    const scrollbarWidth = Math.max(0, windowRef.innerWidth - root.clientWidth);
    const computedPadding = Number.parseFloat(windowRef.getComputedStyle(body).paddingRight) || 0;
    state = {
      scrollX: windowRef.scrollX,
      scrollY: windowRef.scrollY,
      rootOverflow: root.style.overflow,
      rootOverscrollBehavior: root.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyOverscrollBehavior: body.style.overscrollBehavior,
      bodyPaddingRight: body.style.paddingRight
    };

    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    if (scrollbarWidth > 0) body.style.paddingRight = `${computedPadding + scrollbarWidth}px`;
  }

  function unlock() {
    if (!state) return;
    const root = documentRef.documentElement;
    const body = documentRef.body;
    const previous = state;
    state = null;
    root.style.overflow = previous.rootOverflow;
    root.style.overscrollBehavior = previous.rootOverscrollBehavior;
    body.style.overflow = previous.bodyOverflow;
    body.style.overscrollBehavior = previous.bodyOverscrollBehavior;
    body.style.paddingRight = previous.bodyPaddingRight;
    windowRef.scrollTo(previous.scrollX, previous.scrollY);
  }

  return { lock, unlock, get locked() { return state !== null; } };
}
