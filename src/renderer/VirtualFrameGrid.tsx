import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export function gridWindow(count: number, width: number, height: number, scrollTop: number) {
  const gap = 12, rowHeight = 272;
  const columns = Math.max(1, Math.floor((width + gap) / 207));
  const rows = Math.ceil(count / columns);
  const firstRow = Math.max(0, Math.min(rows - 1, Math.floor(scrollTop / rowHeight)) - 2);
  const endRow = Math.min(rows, Math.ceil((scrollTop + height) / rowHeight) + 2);
  return { columns, start: firstRow * columns, end: endRow * columns,
    offset: firstRow * rowHeight, height: rows * rowHeight };
}

/** Keep only the visible rows and a small scroll buffer mounted. */
export function VirtualFrameGrid<T>({ items, sessionId, render }: {
  items: T[]; sessionId: string; render: (item: T, index: number) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 660, top: 0 });
  useLayoutEffect(() => {
    const element = root.current!;
    element.scrollTop = 0;
    const measure = () => {
      const style = getComputedStyle(element);
      setViewport({ width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: element.clientHeight, top: element.scrollTop });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener('scroll', measure); };
  }, [sessionId]);
  const range = gridWindow(items.length, viewport.width, viewport.height, viewport.top);
  return <div ref={root} className="frame-grid virtual-frame-grid" tabIndex={0} aria-label="Candidate stills">
    <div className="virtual-frame-canvas" style={{ height: range.height }}>
      <div className="virtual-frame-rows" style={{ top: range.offset, gridTemplateColumns: `repeat(${range.columns}, minmax(0, 1fr))` }}>
        {items.slice(range.start, range.end).map((item, index) => render(item, range.start + index))}
      </div>
    </div>
  </div>;
}
