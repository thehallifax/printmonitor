import { describe, expect, it, vi } from "vitest";
import { createPageScrollLock } from "../public/modal-scroll-lock.js";

function fixture({ scrollX = 0, scrollY = 1200, innerWidth = 1200, clientWidth = 1184, paddingRight = "4px" } = {}) {
  const root = { clientWidth, style: { overflow: "scroll", overscrollBehavior: "auto" } };
  const body = { style: { overflow: "visible", overscrollBehavior: "auto", paddingRight: "" } };
  const windowRef = {
    innerWidth,
    scrollX,
    scrollY,
    getComputedStyle: () => ({ paddingRight }),
    scrollTo: vi.fn()
  };
  return { documentRef: { documentElement: root, body }, windowRef, root, body };
}

describe("printer Detail page scroll lock", () => {
  it("locks both page scroll containers and compensates for the removed scrollbar", () => {
    const context = fixture();
    const lock = createPageScrollLock(context.documentRef, context.windowRef);
    lock.lock();
    expect(lock.locked).toBe(true);
    expect(context.root.style).toMatchObject({ overflow: "hidden", overscrollBehavior: "none" });
    expect(context.body.style).toMatchObject({ overflow: "hidden", overscrollBehavior: "none", paddingRight: "20px" });
  });

  it("restores prior styles and the exact fleet scroll position", () => {
    const context = fixture({ scrollX: 18, scrollY: 4321 });
    const lock = createPageScrollLock(context.documentRef, context.windowRef);
    lock.lock();
    lock.unlock();
    expect(lock.locked).toBe(false);
    expect(context.root.style).toEqual({ overflow: "scroll", overscrollBehavior: "auto" });
    expect(context.body.style).toEqual({ overflow: "visible", overscrollBehavior: "auto", paddingRight: "" });
    expect(context.windowRef.scrollTo).toHaveBeenCalledOnce();
    expect(context.windowRef.scrollTo).toHaveBeenCalledWith(18, 4321);
  });

  it("is idempotent and leaves no temporary state after close", () => {
    const context = fixture({ scrollY: 800, innerWidth: 800, clientWidth: 800 });
    const lock = createPageScrollLock(context.documentRef, context.windowRef);
    lock.lock();
    lock.lock();
    expect(context.body.style.paddingRight).toBe("");
    lock.unlock();
    lock.unlock();
    expect(context.windowRef.scrollTo).toHaveBeenCalledTimes(1);
    expect(lock.locked).toBe(false);
  });
});
