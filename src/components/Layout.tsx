import type { ReactNode } from "react";

type LayoutProps = {
  left: ReactNode;
  main: ReactNode;
  right: ReactNode;
};

export function Layout({ left, main, right }: LayoutProps) {
  return (
    <div className="grain min-h-screen lg:h-screen lg:overflow-hidden">
      <div className="grid min-h-screen gap-3 p-3 lg:h-screen lg:grid-cols-[368px_minmax(0,1fr)_336px] lg:overflow-hidden xl:grid-cols-[392px_minmax(0,1fr)_360px]">
        <aside className="scrollbar-thin min-h-0 lg:sticky lg:top-3 lg:h-[calc(100vh-1.5rem)] lg:overflow-y-auto">
          {left}
        </aside>
        <main className="scrollbar-thin min-h-0 lg:h-[calc(100vh-1.5rem)] lg:overflow-y-auto">
          {main}
        </main>
        <aside className="scrollbar-thin min-h-0 lg:sticky lg:top-3 lg:h-[calc(100vh-1.5rem)] lg:overflow-y-auto">
          {right}
        </aside>
      </div>
    </div>
  );
}
