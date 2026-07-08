import type { ReactNode } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export function AppHeader({
  title,
  afterTitle,
  children,
  className,
  titleClassName,
  actionsClassName,
}: {
  title: ReactNode;
  afterTitle?: ReactNode;
  children?: ReactNode;
  className?: string;
  titleClassName?: string;
  actionsClassName?: string;
}) {
  return (
    <header
      className={cn(
        "app-header flex h-12 shrink-0 items-center gap-2 border-b bg-background/95",
        className,
      )}
    >
      <SidebarTrigger />
      <h1
        data-tauri-drag-region
        className={cn("min-w-0 truncate text-sm font-medium", titleClassName)}
      >
        {title}
      </h1>
      {afterTitle}
      <div
        data-tauri-drag-region
        aria-hidden="true"
        className="min-w-4 flex-1 self-stretch"
      />
      {children ? (
        <div className={cn("flex shrink-0 items-center gap-2", actionsClassName)}>
          {children}
        </div>
      ) : null}
    </header>
  );
}
