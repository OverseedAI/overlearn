import { ChevronRight, Sparkles } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type { TopicNode } from "@/lib/types";

type TopicTreeProps = {
  topics: TopicNode[];
  frontierDisabled?: boolean;
  onNavigate: (path: string) => void;
};

function containsCurrent(topic: TopicNode): boolean {
  return topic.current || topic.children.some(containsCurrent);
}

function TopicBranch({
  topic,
  frontierDisabled,
  onNavigate,
}: {
  topic: TopicNode;
  frontierDisabled: boolean;
  onNavigate: (path: string) => void;
}) {
  const isFrontier = topic.state === "frontier";
  const disabled = isFrontier && frontierDisabled;
  const selectOrNavigate = () => {
    if (topic.current || disabled) {
      return;
    }

    onNavigate(topic.path);
  };
  const buttonLabel = topic.current
    ? `${topic.title} (current topic)`
    : isFrontier
      ? `Enter ${topic.title} with mentor`
      : `Switch to ${topic.title}`;
  const buttonClassName = cn(
    "w-full justify-between",
    isFrontier &&
      "border border-dashed border-sidebar-border/80 text-sidebar-foreground/65 hover:border-sidebar-accent-foreground/40 [&>svg]:text-sidebar-foreground/50",
  );
  const buttonContent = (
    <>
      <span className="truncate">{topic.title}</span>
      {isFrontier ? (
        <Sparkles className="size-4 shrink-0" aria-hidden="true" />
      ) : null}
    </>
  );

  if (topic.children.length === 0) {
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          asChild
          isActive={topic.current}
          className={buttonClassName}
        >
          <button
            type="button"
            disabled={disabled}
            aria-label={buttonLabel}
            onClick={selectOrNavigate}
          >
            {buttonContent}
          </button>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  }

  return (
    <SidebarMenuSubItem>
      <Collapsible defaultOpen={containsCurrent(topic)} className="group/branch">
        <div className="flex items-center">
          <SidebarMenuSubButton
            asChild
            isActive={topic.current}
            className={cn("flex-1", buttonClassName)}
          >
            <button
              type="button"
              disabled={disabled}
              aria-label={buttonLabel}
              onClick={selectOrNavigate}
            >
              {buttonContent}
            </button>
          </SidebarMenuSubButton>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent"
              aria-label={`Toggle ${topic.title}`}
            >
              <ChevronRight className="size-4 transition-transform group-data-[state=open]/branch:rotate-90" />
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 pr-0">
            {topic.children.map((child) => (
              <TopicBranch
                key={child.path}
                topic={child}
                frontierDisabled={frontierDisabled}
                onNavigate={onNavigate}
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuSubItem>
  );
}

export function TopicTree({
  topics,
  frontierDisabled = false,
  onNavigate,
}: TopicTreeProps) {
  if (topics.length === 0) {
    return (
      <p className="px-2 py-1.5 text-sm text-muted-foreground">
        Your map is empty — tell your mentor where to start.
      </p>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuSub className="mx-0 border-none px-1.5">
          {topics.map((topic) => (
            <TopicBranch
              key={topic.path}
              topic={topic}
              frontierDisabled={frontierDisabled}
              onNavigate={onNavigate}
            />
          ))}
        </SidebarMenuSub>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
